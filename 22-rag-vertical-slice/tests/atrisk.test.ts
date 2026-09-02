/**
 * The hurt column, held to what it can actually observe.
 *
 * `hurt` counts escalated queries that were correct before escalating and
 * wrong after. At any trigger at or below the refusal floor that set is
 * empty by construction: escalation fires iff the k1 score is under the
 * trigger, a score under the floor is refused, and a refusal is not
 * correct. So the headline row (trigger 0.35, floor 0.35) and both oracle
 * rows report hurt = 0 with nothing at risk, and the readme read the whole
 * column as "measured, not assumed".
 *
 * PolicyRow now carries `atRisk` — the escalated queries that were correct
 * going in, the only ones hurt could ever count — so a 0 with no denominator
 * is visible as vacuous instead of reading as evidence.
 *
 * These tests pin the invariant, pin the per-trigger at-risk counts on the
 * committed golden set, hold the live endpoint to the projection on the new
 * column, and hold the readme to the corrected claim.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { loadDocs, loadQueries } from "../src/data.js";
import { MIN_OVERLAP } from "../src/model.js";
import { createRagServer } from "../src/server.js";
import { evalGolden, type QueryOutcome } from "../src/eval.js";
import { captureKFacts, livePolicyRow, oracleRow, projectPolicyRow, type KCapture } from "../src/escalate.js";

const docs = loadDocs();
const queries = loadQueries(docs);

const README = new URL("../README.md", import.meta.url);

/** Collapse whitespace: a claim that wraps across lines must still match. */
function squash(text: string): string {
  return text.replace(/\s+/g, " ");
}

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

async function withServer<T>(
  options: Parameters<typeof createRagServer>[1],
  run: (url: string) => Promise<T>,
): Promise<T> {
  const rag = createRagServer(docs, options);
  await new Promise<void>((resolve) => rag.server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(rag.server.address() as AddressInfo).port}`;
  try {
    return await run(url);
  } finally {
    rag.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => rag.server.close((err) => (err ? reject(err) : resolve())));
  }
}

describe("atRisk: the denominator hurt was missing", () => {
  // One query that is correct at k1 and wrong at k2: hurt fires only if it escalates.
  const flipper = [kc({ queryId: "flip", bestOverlap: 0.4, wouldCorrect: true })];
  const flipperK2 = [kc({ queryId: "flip", bestOverlap: 0.6, wouldCorrect: false, tokensInContext: 900 })];

  it("counts the escalated queries that were correct going in", () => {
    const row = projectPolicyRow(flipper, flipperK2, MIN_OVERLAP, { trigger: 0.45, k2: 10 });
    expect(row.escalated).toBe(1);
    expect(row.atRisk).toBe(1);
    expect(row.hurt).toBe(1);
  });

  it("reports 0 at risk when the same captures never escalate the correct query", () => {
    const row = projectPolicyRow(flipper, flipperK2, MIN_OVERLAP, { trigger: 0.35, k2: 10 });
    expect(row.escalated).toBe(0);
    expect(row.atRisk).toBe(0);
    // hurt is 0 here for a different reason than it is 0 in a row that risked something.
    expect(row.hurt).toBe(0);
  });

  it("is 0 for every trigger at or below the floor, however the captures are built", () => {
    // A whole set of queries that would flip wrong at k2, at scores spread
    // across the floor: none of the ones above it can ever escalate here.
    const capK1 = [0.0, 0.2, 0.34, 0.35, 0.5, 0.9].map((s, i) =>
      kc({ queryId: `q${i}`, bestOverlap: s, wouldCorrect: true }),
    );
    const capK2 = capK1.map((c) => kc({ queryId: c.queryId, bestOverlap: 0.9, wouldCorrect: false }));
    for (const trigger of [0, 0.1, 0.2, 0.34, MIN_OVERLAP]) {
      const row = projectPolicyRow(capK1, capK2, MIN_OVERLAP, { trigger, k2: 10 });
      expect(row.atRisk).toBe(0);
      expect(row.hurt).toBe(0);
    }
    // Just above the floor the column starts carrying information.
    const above = projectPolicyRow(capK1, capK2, MIN_OVERLAP, { trigger: 0.36, k2: 10 });
    expect(above.atRisk).toBe(1);
    expect(above.hurt).toBe(1);
  });

  it("is 0 on an oracle row by construction: it escalates only what it fixes", () => {
    const row = oracleRow(flipper, flipperK2, MIN_OVERLAP, 10);
    expect(row.escalated).toBe(0);
    expect(row.atRisk).toBe(0);
    expect(row.hurt).toBe(0);
  });
});

describe("atRisk on the committed golden set", () => {
  let capK3: KCapture[];
  let capK5: KCapture[];
  let capK10: KCapture[];
  let liveOutcomes: QueryOutcome[];
  const livePolicy = { trigger: 0.45, k2: 5 };

  beforeAll(async () => {
    await withServer({ minOverlap: 0 }, async (url) => {
      capK3 = captureKFacts((await evalGolden(url, queries, 3)).outcomes);
      capK5 = captureKFacts((await evalGolden(url, queries, 5)).outcomes);
      capK10 = captureKFacts((await evalGolden(url, queries, 10)).outcomes);
    });
    liveOutcomes = await withServer({ escalation: livePolicy }, async (url) =>
      (await evalGolden(url, queries, 3)).outcomes,
    );
  });

  const expected: [number, number][] = [
    [0.35, 0],
    [0.45, 5],
    [0.55, 6],
    [0.75, 15],
    [Infinity, 18],
  ];

  it("pins what each swept trigger actually put at risk", () => {
    for (const k2 of [5, 10]) {
      const capK2 = k2 === 5 ? capK5 : capK10;
      for (const [trigger, atRisk] of expected) {
        const row = projectPolicyRow(capK3, capK2, MIN_OVERLAP, { trigger, k2 });
        expect(row.atRisk, `k2=${k2} trigger=${trigger}`).toBe(atRisk);
        expect(row.hurt, `k2=${k2} trigger=${trigger}`).toBe(0);
      }
      expect(oracleRow(capK3, capK2, MIN_OVERLAP, k2).atRisk).toBe(0);
    }
  });

  it("the headline row risks nothing while the rows above the floor risk plenty", () => {
    const headline = projectPolicyRow(capK3, capK10, MIN_OVERLAP, { trigger: MIN_OVERLAP, k2: 10 });
    expect(headline.escalated).toBe(12);
    expect(headline.atRisk).toBe(0);
    const always = projectPolicyRow(capK3, capK10, MIN_OVERLAP, { trigger: Infinity, k2: 10 });
    expect(always.escalated).toBe(queries.length);
    // every correct answer at k=3 escalates under always, and none of them flips
    expect(always.atRisk).toBe(18);
    expect(always.hurt).toBe(0);
  });

  it("k2=10 cannot serve an escalated query without its gold doc: the whole corpus is the context", () => {
    expect(capK10.filter((c) => !c.hit).length).toBe(0);
    // k2=5 is where the column is measured — misses still exist there.
    expect(capK5.filter((c) => !c.hit).length).toBe(2);
  });

  it("the live endpoint reproduces the projected row on the new column too", () => {
    const projected = projectPolicyRow(capK3, capK5, MIN_OVERLAP, livePolicy);
    const live = livePolicyRow(liveOutcomes, capK3, MIN_OVERLAP, livePolicy);
    expect(live).toEqual(projected);
    expect(live.atRisk).toBe(5);
  });
});

describe("the readme states what the hurt column can and cannot show", () => {
  const body = squash(readFileSync(README, "utf-8")).split("## fixes")[0] as string;

  it("no longer sells the whole column as measured", () => {
    expect(body).not.toContain("the hurt column is 0 everywhere, and thats measured, not assumed");
  });

  it("names the trigger-0.35 and oracle zeros as structural", () => {
    expect(body).toContain("escalation only ever fires on a query that already refused");
  });

  it("names the at-risk counts the rows above the floor actually carry", () => {
    expect(body).toContain("5 correct answers escalate at 0.45, 6 at 0.55, 15 at 0.75, 18 at always");
  });

  it("does not claim answered-without-gold is measured at k2=10", () => {
    expect(body).toContain("no escalated query can be missing its gold doc");
    expect(body).toContain("2 queries still miss gold at k=5");
  });

  it("carries the at-risk column in the policy table", () => {
    const raw = readFileSync(README, "utf-8");
    expect(raw).toContain("atrisk");
    // the headline row, verbatim from the entry point
    expect(raw).toContain("  k2=10 trig 0.35        12      1     0      0       0    0.475    5056.3    $0.6272     61.5%");
  });
});
