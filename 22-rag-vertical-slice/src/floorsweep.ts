/**
 * The refusal-floor sweep. The endpoint refuses when the best context
 * sentence's overlap score sits under a floor; the shipped floor is 0.35
 * and this module prices every other choice. The key structural fact makes
 * the sweep cheap to reason about: the best sentence never depends on the
 * floor, only whether it is served does, so one floor-0 run (every query
 * answered) captures each query's score, its would-be answer's
 * correctness, and whether the gold doc was retrieved — and any floor's
 * row is a pure function of those triples. The live sweep still runs the
 * real endpoint at every floor and the projection must agree with it
 * exactly; the projection is the analysis, the live runs are the proof it
 * describes the deployed behavior.
 *
 * The score doubles as a confidence signal, judged as a ranker with 20's
 * ROC machinery: positives are queries whose would-be answer is correct,
 * negatives are queries whose would-be answer is wrong (wrong sentence or
 * wrong doc). A floor is exactly an operating point on that curve.
 */

import { rocAuc, sweepThresholds, type RocPoint } from "../../20-guardrails/src/metrics.js";
import type { QueryOutcome } from "./eval.js";

export { rocAuc, sweepThresholds };
export type { RocPoint };

/** One query's floor-independent facts, captured from a floor-0 eval run. */
export interface ScoredQuery {
  queryId: string;
  /** Gold doc was among the k retrieved. */
  hit: boolean;
  /** The best sentence's overlap score. */
  bestOverlap: number;
  /** The answer the model would serve at any floor <= bestOverlap contains the gold sentence. */
  wouldCorrect: boolean;
}

/**
 * Turn a floor-0 eval's outcomes into per-query score records. At floor 0
 * every query is answered (any best sentence scores >= 0), so `correct`
 * IS the would-be correctness; a refusal here means the capture ran
 * against the wrong server.
 */
export function captureScores(outcomes: readonly QueryOutcome[]): ScoredQuery[] {
  return outcomes.map((o) => {
    if (o.served !== "answered") {
      throw new Error(`captureScores expects a floor-0 run where every query answers; ${o.queryId} refused`);
    }
    return { queryId: o.queryId, hit: o.hit, bestOverlap: o.bestOverlap, wouldCorrect: o.correct };
  });
}

/** What one floor buys and costs, over the full golden set. */
export interface FloorRow {
  floor: number;
  queries: number;
  answered: number;
  refused: number;
  /** Correct answers over all queries. */
  answerAccuracy: number;
  /** Correct answers over answered queries; 1 when nothing answered. */
  accuracyAmongAnswered: number;
  /** Answered but wrong (wrong sentence or wrong doc). */
  wrongAnswered: number;
  /** Answered while the gold doc was not retrieved: the confident wrong-doc quote. */
  answeredWithoutGold: number;
  /** Refused although the would-be answer was correct: right answers the floor eats. */
  refusedWouldBeCorrect: number;
}

/** A floor's row computed offline from captured scores: answered iff score >= floor. */
export function projectFloorRow(scored: readonly ScoredQuery[], floor: number): FloorRow {
  const answered = scored.filter((s) => s.bestOverlap >= floor);
  const refused = scored.filter((s) => s.bestOverlap < floor);
  const correct = answered.filter((s) => s.wouldCorrect).length;
  return {
    floor,
    queries: scored.length,
    answered: answered.length,
    refused: refused.length,
    answerAccuracy: scored.length === 0 ? 0 : correct / scored.length,
    accuracyAmongAnswered: answered.length === 0 ? 1 : correct / answered.length,
    wrongAnswered: answered.length - correct,
    answeredWithoutGold: answered.filter((s) => !s.hit).length,
    refusedWouldBeCorrect: refused.filter((s) => s.wouldCorrect).length,
  };
}

/**
 * The same row read off a live eval run against a server configured with
 * this floor. `refusedWouldBeCorrect` needs the would-be answer of a query
 * that refused, which the live run never streamed — that one column joins
 * the floor-0 capture by query id.
 */
export function liveFloorRow(outcomes: readonly QueryOutcome[], scored: readonly ScoredQuery[], floor: number): FloorRow {
  const wouldCorrect = new Map(scored.map((s) => [s.queryId, s.wouldCorrect]));
  const answered = outcomes.filter((o) => o.served === "answered");
  const refused = outcomes.filter((o) => o.served === "refused");
  const correct = answered.filter((o) => o.correct).length;
  const refusedWouldBeCorrect = refused.filter((o) => {
    const would = wouldCorrect.get(o.queryId);
    if (would === undefined) throw new Error(`no captured score for ${o.queryId}`);
    return would;
  }).length;
  return {
    floor,
    queries: outcomes.length,
    answered: answered.length,
    refused: refused.length,
    answerAccuracy: outcomes.length === 0 ? 0 : correct / outcomes.length,
    accuracyAmongAnswered: answered.length === 0 ? 1 : correct / answered.length,
    wrongAnswered: answered.length - correct,
    answeredWithoutGold: answered.filter((o) => !o.hit).length,
    refusedWouldBeCorrect,
  };
}

/** Per-class score summary for the correct-vs-wrong separation story. */
export interface ScoreStats {
  count: number;
  min: number;
  mean: number;
  max: number;
}

export function scoreStats(scores: readonly number[]): ScoreStats {
  if (scores.length === 0) return { count: 0, min: NaN, mean: NaN, max: NaN };
  return {
    count: scores.length,
    min: Math.min(...scores),
    mean: scores.reduce((a, b) => a + b, 0) / scores.length,
    max: Math.max(...scores),
  };
}

export function correctScores(scored: readonly ScoredQuery[]): number[] {
  return scored.filter((s) => s.wouldCorrect).map((s) => s.bestOverlap);
}

export function wrongScores(scored: readonly ScoredQuery[]): number[] {
  return scored.filter((s) => !s.wouldCorrect).map((s) => s.bestOverlap);
}

/**
 * Youden's J = recall - fpr over 20's sweep points; the floor that keeps
 * the most correct answers per wrong answer kept. Tie goes to the lowest
 * threshold, matching 12's sweep convention.
 */
export function youdenBest(points: readonly RocPoint[]): RocPoint {
  if (points.length === 0) throw new Error("youdenBest needs at least one point");
  let best = points[0] as RocPoint;
  for (const p of points) {
    if (p.recall - p.fpr > best.recall - best.fpr) best = p;
  }
  return best;
}
