import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { costUsd } from "../../08-agent-tool-loop/src/messages.js";
import { loadDocs, loadQueries, type GoldenQuery } from "../src/data.js";
import { MIN_OVERLAP, bestSentence, scoredAnswer } from "../src/model.js";
import { computeUsage, createRagServer, type RagServer } from "../src/server.js";
import { DocIndex } from "../src/retrieval.js";
import { ask } from "../src/client.js";
import { evalGolden, type QueryOutcome } from "../src/eval.js";
import {
  captureKFacts,
  livePolicyRow,
  oracleRow,
  projectPolicyRow,
  REFUSAL_TOKENS,
  type KCapture,
} from "../src/escalate.js";

const docs = loadDocs();
const queries = loadQueries(docs);
const index = new DocIndex(docs);

/** A golden query whose gold doc is NOT in the k=3 retrieval (must exist for the study to mean anything). */
const missQuery = queries.find((q) => !index.topK(q.query, 3).some((r) => r.doc.id === q.docId)) as GoldenQuery;
/** A golden query that answers confidently at k=3. */
const confidentQuery = queries.find((q) => {
  const best = bestSentence(q.query, index.topK(q.query, 3).map((r) => r.doc));
  return best !== undefined && best.overlap >= 0.6;
}) as GoldenQuery;

function kc(overrides: Partial<KCapture>): KCapture {
  return {
    queryId: "q",
    hit: true,
    bestOverlap: 0.5,
    wouldCorrect: true,
    tokensInSystem: 40,
    tokensInQuestion: 10,
    tokensInContext: 300,
    tokensOutAnswer: 20,
    ...overrides,
  };
}

describe("projectPolicyRow", () => {
  it("never escalates at trigger 0 and reproduces the fixed-k1 bill", () => {
    const c1 = kc({ bestOverlap: 0.2, wouldCorrect: false });
    const c2 = kc({ bestOverlap: 0.9, tokensInContext: 900 });
    const row = projectPolicyRow([c1], [c2], MIN_OVERLAP, { trigger: 0, k2: 10 });
    expect(row.escalated).toBe(0);
    expect(row.refused).toBe(1);
    expect(row.totalTokensIn).toBe(40 + 10 + 300);
    expect(row.totalCostUsd).toBe(costUsd(350, REFUSAL_TOKENS));
  });

  it("escalates everything at trigger Infinity and bills both calls", () => {
    const c1 = kc({ bestOverlap: 0.5, wouldCorrect: true });
    const c2 = kc({ bestOverlap: 0.5, wouldCorrect: true, tokensInContext: 900, tokensOutAnswer: 20 });
    const row = projectPolicyRow([c1], [c2], MIN_OVERLAP, { trigger: Infinity, k2: 10 });
    expect(row.escalated).toBe(1);
    expect(row.totalTokensIn).toBe(350 + 950);
    // First call bills the suppressed draft's output, second the served answer.
    expect(row.totalCostUsd).toBe(costUsd(350, 20) + costUsd(950, 20));
    expect(row.correct).toBe(1);
    expect(row.helped).toBe(0);
    expect(row.hurt).toBe(0);
  });

  it("counts a retrieval miss the wider context converts as helped", () => {
    const c1 = kc({ hit: false, bestOverlap: 0.2, wouldCorrect: false });
    const c2 = kc({ hit: true, bestOverlap: 0.7, wouldCorrect: true, tokensInContext: 900 });
    const row = projectPolicyRow([c1], [c2], MIN_OVERLAP, { trigger: 0.35, k2: 10 });
    expect(row.escalated).toBe(1);
    expect(row.helped).toBe(1);
    expect(row.hurt).toBe(0);
    expect(row.correct).toBe(1);
    expect(row.answered).toBe(1);
    expect(row.answerAccuracy).toBe(1);
  });

  it("bills two refusal drafts when escalation still cannot clear the floor", () => {
    const c1 = kc({ bestOverlap: 0.2, wouldCorrect: false });
    const c2 = kc({ bestOverlap: 0.3, wouldCorrect: false, tokensInContext: 900 });
    const row = projectPolicyRow([c1], [c2], MIN_OVERLAP, { trigger: 0.35, k2: 10 });
    expect(row.escalated).toBe(1);
    expect(row.helped).toBe(0);
    expect(row.refused).toBe(1);
    expect(row.totalCostUsd).toBe(costUsd(350, REFUSAL_TOKENS) + costUsd(950, REFUSAL_TOKENS));
  });

  it("counts a correct answer the wider context flips wrong as hurt", () => {
    const c1 = kc({ bestOverlap: 0.4, wouldCorrect: true });
    const c2 = kc({ bestOverlap: 0.6, wouldCorrect: false, tokensInContext: 900 });
    const row = projectPolicyRow([c1], [c2], MIN_OVERLAP, { trigger: 0.45, k2: 10 });
    expect(row.escalated).toBe(1);
    expect(row.hurt).toBe(1);
    expect(row.helped).toBe(0);
    expect(row.correct).toBe(0);
  });

  it("bills the k1 answer as the suppressed draft when the first pass would have answered", () => {
    const c1 = kc({ bestOverlap: 0.4, wouldCorrect: true, tokensOutAnswer: 33 });
    const c2 = kc({ bestOverlap: 0.6, wouldCorrect: true, tokensInContext: 900, tokensOutAnswer: 25 });
    const row = projectPolicyRow([c1], [c2], MIN_OVERLAP, { trigger: 0.45, k2: 10 });
    expect(row.totalCostUsd).toBe(costUsd(350, 33) + costUsd(950, 25));
  });

  it("surfaces an answered-without-gold serve the wider context introduces", () => {
    const c1 = kc({ hit: false, bestOverlap: 0.1, wouldCorrect: false });
    const c2 = kc({ hit: false, bestOverlap: 0.5, wouldCorrect: false, tokensInContext: 900 });
    const row = projectPolicyRow([c1], [c2], MIN_OVERLAP, { trigger: 0.35, k2: 10 });
    expect(row.answeredWithoutGold).toBe(1);
    expect(row.correct).toBe(0);
  });

  it("throws when the k2 capture is missing a query", () => {
    expect(() => projectPolicyRow([kc({})], [kc({ queryId: "other" })], MIN_OVERLAP, { trigger: 0.35, k2: 5 })).toThrow(
      /no k2 capture/,
    );
  });

  it("handles an empty capture", () => {
    const row = projectPolicyRow([], [], MIN_OVERLAP, { trigger: 0.35, k2: 5 });
    expect(row.queries).toBe(0);
    expect(row.answerAccuracy).toBe(0);
    expect(row.meanTokensIn).toBe(0);
  });
});

describe("oracleRow", () => {
  it("escalates exactly the queries escalation turns correct", () => {
    const helped1 = kc({ queryId: "a", hit: false, bestOverlap: 0.2, wouldCorrect: false });
    const helped2 = kc({ queryId: "a", hit: true, bestOverlap: 0.7, wouldCorrect: true, tokensInContext: 900 });
    const hopeless1 = kc({ queryId: "b", bestOverlap: 0.2, wouldCorrect: false });
    const hopeless2 = kc({ queryId: "b", bestOverlap: 0.3, wouldCorrect: false, tokensInContext: 900 });
    const fine1 = kc({ queryId: "c", bestOverlap: 0.8, wouldCorrect: true });
    const fine2 = kc({ queryId: "c", bestOverlap: 0.8, wouldCorrect: true, tokensInContext: 900 });
    const row = oracleRow([helped1, hopeless1, fine1], [helped2, hopeless2, fine2], MIN_OVERLAP, 10);
    expect(row.escalated).toBe(1);
    expect(row.helped).toBe(1);
    expect(row.hurt).toBe(0);
    expect(row.correct).toBe(2);
    expect(Number.isNaN(row.trigger)).toBe(true);
  });
});

describe("escalation on the real corpus (pure pipeline)", () => {
  it("has at least one k=3 retrieval miss and one confident answer to test against", () => {
    expect(missQuery).toBeDefined();
    expect(confidentQuery).toBeDefined();
  });

  it("widening k never lowers the best overlap (superset context)", () => {
    for (const query of queries) {
      const at3 = bestSentence(query.query, index.topK(query.query, 3).map((r) => r.doc));
      const at10 = bestSentence(query.query, index.topK(query.query, 10).map((r) => r.doc));
      expect((at10?.overlap ?? 0) >= (at3?.overlap ?? 0)).toBe(true);
    }
  });

  it("topK at a wider k starts with the narrower ranking (prefix property)", () => {
    for (const query of queries) {
      const at3 = index.topK(query.query, 3).map((r) => r.doc.id);
      const at5 = index.topK(query.query, 5).map((r) => r.doc.id);
      expect(at5.slice(0, 3)).toEqual(at3);
    }
  });
});

describe("escalation server", () => {
  const policy = { trigger: 0.45, k2: 5 };
  let rag: RagServer;
  let baseUrl: string;

  beforeAll(async () => {
    rag = createRagServer(docs, { escalation: policy });
    await new Promise<void>((resolve) => rag.server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(rag.server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    rag.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => rag.server.close((err) => (err ? reject(err) : resolve())));
  });

  it("escalates a retrieval miss: wider meta, both calls billed, flags on the wire", async () => {
    const result = await ask(baseUrl, { question: missQuery.query, k: 3 });
    expect(result.escalated).toBe(true);
    expect(result.kUsed).toBe(5);
    expect(result.meta?.retrieved).toHaveLength(5);
    expect(result.firstOverlap).toBeLessThan(policy.trigger);

    const context3 = index.topK(missQuery.query, 3).map((r) => r.doc);
    const context5 = index.topK(missQuery.query, 5).map((r) => r.doc);
    const draft = scoredAnswer(missQuery.query, context3);
    const served = scoredAnswer(missQuery.query, context5);
    expect(result.answer).toBe(served.answer);
    expect(result.bestOverlap).toBe(served.bestOverlap);
    expect(result.firstOverlap).toBe(draft.bestOverlap);

    const firstUsage = computeUsage(missQuery.query, context3, draft.answer);
    const secondUsage = computeUsage(missQuery.query, context5, served.answer);
    expect(result.usage?.tokensIn).toBe(firstUsage.tokensIn + secondUsage.tokensIn);
    expect(result.usage?.tokensOut).toBe(firstUsage.tokensOut + secondUsage.tokensOut);
    expect(result.usage?.costUsd).toBe(firstUsage.costUsd + secondUsage.costUsd);
  });

  it("does not escalate a confident answer and bills a single pass", async () => {
    const result = await ask(baseUrl, { question: confidentQuery.query, k: 3 });
    expect(result.escalated).toBe(false);
    expect(result.kUsed).toBe(3);
    expect(result.meta?.retrieved).toHaveLength(3);
    const context3 = index.topK(confidentQuery.query, 3).map((r) => r.doc);
    const served = scoredAnswer(confidentQuery.query, context3);
    expect(result.answer).toBe(served.answer);
    expect(result.usage).toEqual(computeUsage(confidentQuery.query, context3, served.answer));
  });

  it("skips escalation when the requested k already covers k2", async () => {
    const result = await ask(baseUrl, { question: missQuery.query, k: 5 });
    expect(result.escalated).toBe(false);
    expect(result.kUsed).toBe(5);
    expect(result.meta?.retrieved).toHaveLength(5);
  });

  it("records the escalation in the request log", async () => {
    const before = rag.log.length;
    await ask(baseUrl, { question: missQuery.query, k: 3 });
    const entry = rag.log[before];
    expect(entry?.escalated).toBe(true);
    expect(entry?.kUsed).toBe(5);
    expect(entry?.firstOverlap).toBeLessThan(policy.trigger);
    expect(entry?.retrieved).toHaveLength(5);
  });
});

describe("server without escalation", () => {
  it("keeps the wire and the log free of escalation fields", async () => {
    const rag = createRagServer(docs);
    await new Promise<void>((resolve) => rag.server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(rag.server.address() as AddressInfo).port}`;
    try {
      const result = await ask(baseUrl, { question: missQuery.query, k: 3 });
      expect(result.escalated).toBeUndefined();
      expect(result.kUsed).toBeUndefined();
      expect(result.firstOverlap).toBeUndefined();
      expect(rag.log[0]).not.toHaveProperty("escalated");
    } finally {
      rag.server.closeAllConnections();
      await new Promise<void>((resolve, reject) => rag.server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it("rejects invalid escalation options", () => {
    expect(() => createRagServer(docs, { escalation: { trigger: 0.35, k2: 0 } })).toThrow(RangeError);
    expect(() => createRagServer(docs, { escalation: { trigger: 0.35, k2: 11 } })).toThrow(RangeError);
    expect(() => createRagServer(docs, { escalation: { trigger: 0.35, k2: 3.5 } })).toThrow(RangeError);
    expect(() => createRagServer(docs, { escalation: { trigger: NaN, k2: 5 } })).toThrow(RangeError);
    expect(() => createRagServer(docs, { escalation: { trigger: -0.1, k2: 5 } })).toThrow(RangeError);
  });
});

describe("live row vs projection", () => {
  const policy = { trigger: 0.45, k2: 5 };
  let capK3: KCapture[];
  let capK5: KCapture[];
  let liveOutcomes: QueryOutcome[];

  beforeAll(async () => {
    const floor0 = createRagServer(docs, { minOverlap: 0 });
    await new Promise<void>((resolve) => floor0.server.listen(0, "127.0.0.1", resolve));
    const floor0Url = `http://127.0.0.1:${(floor0.server.address() as AddressInfo).port}`;
    try {
      capK3 = captureKFacts((await evalGolden(floor0Url, queries, 3)).outcomes);
      capK5 = captureKFacts((await evalGolden(floor0Url, queries, 5)).outcomes);
    } finally {
      floor0.server.closeAllConnections();
      await new Promise<void>((resolve, reject) => floor0.server.close((err) => (err ? reject(err) : resolve())));
    }

    const escalationRag = createRagServer(docs, { escalation: policy });
    await new Promise<void>((resolve) => escalationRag.server.listen(0, "127.0.0.1", resolve));
    const escalationUrl = `http://127.0.0.1:${(escalationRag.server.address() as AddressInfo).port}`;
    try {
      liveOutcomes = (await evalGolden(escalationUrl, queries, 3)).outcomes;
    } finally {
      escalationRag.server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        escalationRag.server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });

  it("the live escalation endpoint reproduces the projected policy row exactly", () => {
    const projected = projectPolicyRow(capK3, capK5, MIN_OVERLAP, policy);
    const live = livePolicyRow(liveOutcomes, capK3, MIN_OVERLAP, policy);
    expect(live).toEqual(projected);
    // The row is not vacuous: this policy escalates a real share of the set.
    expect(projected.escalated).toBeGreaterThan(0);
    expect(projected.escalated).toBeLessThan(queries.length);
  });

  it("captureKFacts refuses a capture from a floored run", async () => {
    const floored = createRagServer(docs);
    await new Promise<void>((resolve) => floored.server.listen(0, "127.0.0.1", resolve));
    const flooredUrl = `http://127.0.0.1:${(floored.server.address() as AddressInfo).port}`;
    try {
      const { outcomes } = await evalGolden(flooredUrl, queries, 3);
      expect(() => captureKFacts(outcomes)).toThrow(/floor-0/);
    } finally {
      floored.server.closeAllConnections();
      await new Promise<void>((resolve, reject) => floored.server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it("livePolicyRow refuses outcomes that carry no escalation flag", () => {
    const stripped = liveOutcomes.map((o) => {
      const { escalated: _escalated, ...rest } = o;
      return rest as QueryOutcome;
    });
    expect(() => livePolicyRow(stripped, capK3, MIN_OVERLAP, policy)).toThrow(/no flag/);
  });
});
