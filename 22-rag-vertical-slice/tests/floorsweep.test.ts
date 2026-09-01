import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { loadDocs, loadQueries } from "../src/data.js";
import { createRagServer, type RagServer } from "../src/server.js";
import { ask } from "../src/client.js";
import { evalGolden } from "../src/eval.js";
import {
  captureScores,
  correctScores,
  liveFloorRow,
  projectFloorRow,
  rocAuc,
  scoreStats,
  sweepThresholds,
  wrongScores,
  youdenBest,
  type ScoredQuery,
} from "../src/floorsweep.js";
import type { QueryOutcome } from "../src/eval.js";

const docs = loadDocs();
const queries = loadQueries(docs);

function sq(overrides: Partial<ScoredQuery>): ScoredQuery {
  return { queryId: "q", hit: true, bestOverlap: 0.5, wouldCorrect: true, ...overrides };
}

describe("projectFloorRow", () => {
  it("handles an empty capture", () => {
    const row = projectFloorRow([], 0.35);
    expect(row.queries).toBe(0);
    expect(row.answered).toBe(0);
    expect(row.answerAccuracy).toBe(0);
    expect(row.accuracyAmongAnswered).toBe(1);
  });

  it("answers on a score exactly at the floor (>= semantics)", () => {
    const row = projectFloorRow([sq({ bestOverlap: 0.35 })], 0.35);
    expect(row.answered).toBe(1);
    expect(row.refused).toBe(0);
    expect(row.answerAccuracy).toBe(1);
  });

  it("refuses just below the floor and counts the eaten correct answer", () => {
    const row = projectFloorRow([sq({ bestOverlap: 0.3499, wouldCorrect: true })], 0.35);
    expect(row.answered).toBe(0);
    expect(row.refused).toBe(1);
    expect(row.refusedWouldBeCorrect).toBe(1);
    expect(row.accuracyAmongAnswered).toBe(1);
  });

  it("splits wrong answers into with-gold and without-gold", () => {
    const scored = [
      sq({ queryId: "a", bestOverlap: 0.9, wouldCorrect: true, hit: true }),
      sq({ queryId: "b", bestOverlap: 0.8, wouldCorrect: false, hit: true }),
      sq({ queryId: "c", bestOverlap: 0.7, wouldCorrect: false, hit: false }),
      sq({ queryId: "d", bestOverlap: 0.1, wouldCorrect: false, hit: false }),
    ];
    const row = projectFloorRow(scored, 0.5);
    expect(row.answered).toBe(3);
    expect(row.refused).toBe(1);
    expect(row.wrongAnswered).toBe(2);
    expect(row.answeredWithoutGold).toBe(1);
    expect(row.refusedWouldBeCorrect).toBe(0);
    expect(row.answerAccuracy).toBeCloseTo(0.25, 12);
    expect(row.accuracyAmongAnswered).toBeCloseTo(1 / 3, 12);
  });

  it("is monotone in the floor: raising it never adds a correct answer", () => {
    const scored = queries.map((q, i) =>
      sq({ queryId: q.id, bestOverlap: (i % 8) / 7, wouldCorrect: i % 3 === 0, hit: i % 5 !== 0 }),
    );
    let previous = projectFloorRow(scored, 0);
    for (const floor of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]) {
      const row = projectFloorRow(scored, floor);
      expect(row.answered).toBeLessThanOrEqual(previous.answered);
      expect(row.answerAccuracy).toBeLessThanOrEqual(previous.answerAccuracy + 1e-12);
      expect(row.refusedWouldBeCorrect).toBeGreaterThanOrEqual(previous.refusedWouldBeCorrect);
      previous = row;
    }
  });
});

describe("captureScores", () => {
  it("maps outcomes and rejects a run that refused anything", () => {
    const answered: QueryOutcome = {
      queryId: "q01",
      category: "keyword",
      hit: true,
      correct: true,
      served: "answered",
      bestOverlap: 0.6,
      usage: { tokensInSystem: 0, tokensInQuestion: 0, tokensInContext: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 },
      wireBytes: 0,
      bytesAtFirstToken: 0,
    };
    expect(captureScores([answered])).toEqual([{ queryId: "q01", hit: true, bestOverlap: 0.6, wouldCorrect: true }]);
    expect(() => captureScores([{ ...answered, served: "refused" }])).toThrow(/floor-0/);
  });
});

describe("scoreStats and youdenBest", () => {
  it("scoreStats handles empty and single inputs", () => {
    expect(scoreStats([]).count).toBe(0);
    expect(Number.isNaN(scoreStats([]).mean)).toBe(true);
    expect(scoreStats([0.4])).toEqual({ count: 1, min: 0.4, mean: 0.4, max: 0.4 });
    expect(scoreStats([0.25, 0.5, 0.75])).toEqual({ count: 3, min: 0.25, mean: 0.5, max: 0.75 });
  });

  it("youdenBest maximizes recall minus fpr, tie to the lowest threshold", () => {
    const points = sweepThresholds([0.6, 0.8], [0.2, 0.6]);
    // thresholds 0.2, 0.6, 0.8: J = 1-1=0, 1-0.5=0.5, 0.5-0=0.5 -> tie, keep 0.6
    expect(youdenBest(points).threshold).toBeCloseTo(0.6, 12);
    expect(() => youdenBest([])).toThrow();
  });
});

describe("floor sweep against the live endpoint", () => {
  let floor0: RagServer;
  let floor0Url: string;
  let scored: ScoredQuery[];

  beforeAll(async () => {
    floor0 = createRagServer(docs, { minOverlap: 0 });
    await new Promise<void>((resolve) => floor0.server.listen(0, "127.0.0.1", resolve));
    floor0Url = `http://127.0.0.1:${(floor0.server.address() as AddressInfo).port}`;
    const { outcomes } = await evalGolden(floor0Url, queries, 3);
    scored = captureScores(outcomes);
  });

  afterAll(async () => {
    floor0.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => floor0.server.close((err) => (err ? reject(err) : resolve())));
  });

  async function liveRowAt(floor: number) {
    const rag = createRagServer(docs, { minOverlap: floor });
    await new Promise<void>((resolve) => rag.server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(rag.server.address() as AddressInfo).port}`;
    try {
      const { outcomes } = await evalGolden(url, queries, 3);
      return liveFloorRow(outcomes, scored, floor);
    } finally {
      rag.server.closeAllConnections();
      await new Promise<void>((resolve, reject) => rag.server.close((err) => (err ? reject(err) : resolve())));
    }
  }

  it("floor 0 answers all 40 queries, so the capture sees every score", () => {
    expect(scored).toHaveLength(queries.length);
    for (const s of scored) expect(s.bestOverlap).toBeGreaterThanOrEqual(0);
  });

  it("the live row at the shipped 0.35 floor equals the floor-0 projection", async () => {
    const live = await liveRowAt(0.35);
    expect(live).toEqual(projectFloorRow(scored, 0.35));
  });

  it("the live row at a floor sitting exactly on an observed score still matches (tie answers)", async () => {
    const minCorrect = Math.min(...correctScores(scored));
    const live = await liveRowAt(minCorrect);
    expect(live).toEqual(projectFloorRow(scored, minCorrect));
    // the tie query must be answered, not refused: >= at the server, >= in the projection
    expect(live.refusedWouldBeCorrect).toBe(0);
  });

  it("a floor above every possible score refuses everything", async () => {
    const live = await liveRowAt(1.01);
    expect(live.answered).toBe(0);
    expect(live.refused).toBe(queries.length);
    expect(live.accuracyAmongAnswered).toBe(1);
    expect(live.refusedWouldBeCorrect).toBe(correctScores(scored).length);
  });

  it("the floor option reaches the model: floor 0 quotes on a garbage question the default floor refuses", async () => {
    const zero = await ask(floor0Url, { question: "xyzzy plugh frobnicate", k: 3 });
    expect(zero.outcome).toBe("answered");
    expect(zero.bestOverlap).toBe(0);

    const dflt = createRagServer(docs);
    await new Promise<void>((resolve) => dflt.server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(dflt.server.address() as AddressInfo).port}`;
    try {
      const refused = await ask(url, { question: "xyzzy plugh frobnicate", k: 3 });
      expect(refused.outcome).toBe("refused");
      expect(refused.bestOverlap).toBe(0);
    } finally {
      dflt.server.closeAllConnections();
      await new Promise<void>((resolve, reject) => dflt.server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it("the overlap score separates correct from wrong answers better than chance", () => {
    const auc = rocAuc(correctScores(scored), wrongScores(scored));
    expect(auc).toBeGreaterThan(0.5);
    expect(auc).toBeLessThanOrEqual(1);
  });

  it("the shipped floor sits inside the free window: above every wrong-doc score, at or below every correct score", () => {
    const noGoldMax = Math.max(...scored.filter((s) => !s.hit).map((s) => s.bestOverlap));
    const minCorrect = Math.min(...correctScores(scored));
    expect(noGoldMax).toBeLessThan(0.35);
    expect(minCorrect).toBeGreaterThanOrEqual(0.35);
    const row = projectFloorRow(scored, 0.35);
    expect(row.answeredWithoutGold).toBe(0);
    expect(row.refusedWouldBeCorrect).toBe(0);
  });
});
