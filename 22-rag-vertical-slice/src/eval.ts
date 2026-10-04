/**
 * The eval hook: run the 40 golden queries against the live endpoint over
 * real HTTP — the same wire path a user takes, not a shortcut into the
 * pipeline functions — and score what comes back. Correct means the
 * streamed answer contains the gold answer sentence verbatim. Every miss
 * is attributed to the stage that caused it: retrieval never brought the
 * gold doc, or retrieval brought it and the model quoted the wrong
 * sentence or refused anyway.
 */

import type { GoldenQuery } from "./data.js";
import { ask } from "./client.js";
import type { Usage } from "./server.js";

export interface QueryOutcome {
  queryId: string;
  category: string;
  /** Gold doc was among the k retrieved. */
  hit: boolean;
  /** Streamed answer contains the gold answer sentence. */
  correct: boolean;
  served: "answered" | "refused";
  /** The overlap score the server's refusal decision was made on. */
  bestOverlap: number;
  usage: Usage;
  wireBytes: number;
  bytesAtFirstToken: number | undefined;
  /** Present only when the server runs an escalation policy. */
  escalated?: boolean;
}

export interface EvalRow {
  k: number;
  queries: number;
  hitAtK: number;
  answerAccuracy: number;
  /** Correct answers among queries whose gold doc was retrieved. */
  extractionAccuracy: number;
  wrongSentence: number;
  refusedWithGold: number;
  answeredWithoutGold: number;
  refusedWithoutGold: number;
  meanContextTokens: number;
  meanTokensIn: number;
  meanCostUsd: number;
  totalCostUsd: number;
  /** Answer accuracy split by the golden set's query category. */
  byCategory: Record<string, { queries: number; answerAccuracy: number }>;
}

export async function evalGolden(
  baseUrl: string,
  queries: readonly GoldenQuery[],
  k: number,
): Promise<{ row: EvalRow; outcomes: QueryOutcome[] }> {
  const outcomes: QueryOutcome[] = [];
  for (const query of queries) {
    const result = await ask(baseUrl, { question: query.query, k });
    if (
      result.status !== 200 ||
      result.meta === undefined ||
      result.usage === undefined ||
      result.outcome === undefined ||
      result.bestOverlap === undefined
    ) {
      throw new Error(`eval: ${query.id} failed with status ${result.status}${result.error === undefined ? "" : `: ${result.error}`}`);
    }
    const outcome: QueryOutcome = {
      queryId: query.id,
      category: query.category,
      hit: result.meta.retrieved.some((r) => r.docId === query.docId),
      correct: result.answer.includes(query.answer),
      served: result.outcome,
      bestOverlap: result.bestOverlap,
      usage: result.usage,
      wireBytes: result.wireBytes,
      bytesAtFirstToken: result.bytesAtFirstToken,
    };
    if (result.escalated !== undefined) outcome.escalated = result.escalated;
    outcomes.push(outcome);
  }

  const n = outcomes.length;
  const hits = outcomes.filter((o) => o.hit);
  const correct = outcomes.filter((o) => o.correct).length;
  const sum = (select: (o: QueryOutcome) => number): number => outcomes.reduce((acc, o) => acc + select(o), 0);
  const totalCostUsd = sum((o) => o.usage.costUsd);
  const byCategory: Record<string, { queries: number; answerAccuracy: number }> = {};
  for (const category of [...new Set(outcomes.map((o) => o.category))].sort()) {
    const slice = outcomes.filter((o) => o.category === category);
    byCategory[category] = {
      queries: slice.length,
      answerAccuracy: slice.filter((o) => o.correct).length / slice.length,
    };
  }
  const row: EvalRow = {
    k,
    queries: n,
    hitAtK: hits.length / n,
    answerAccuracy: correct / n,
    extractionAccuracy: hits.length === 0 ? 0 : hits.filter((o) => o.correct).length / hits.length,
    wrongSentence: hits.filter((o) => !o.correct && o.served === "answered").length,
    refusedWithGold: hits.filter((o) => !o.correct && o.served === "refused").length,
    answeredWithoutGold: outcomes.filter((o) => !o.hit && o.served === "answered").length,
    refusedWithoutGold: outcomes.filter((o) => !o.hit && o.served === "refused").length,
    meanContextTokens: sum((o) => o.usage.tokensInContext) / n,
    meanTokensIn: sum((o) => o.usage.tokensIn) / n,
    meanCostUsd: totalCostUsd / n,
    totalCostUsd,
    byCategory,
  };
  return { row, outcomes };
}

/**
 * Where a k sweep's extraction accuracy drift comes from. Two mechanisms
 * could move it as k grows: a wider context steals a pick the reader was
 * winning (a query correct at one k, wrong at a wider one), or the gold
 * docs that only arrive at a wider k are simply harder than the ones
 * retrieved first. The first is a claim about the same query changing
 * answer, so it is countable — and on this corpus it never happens, which
 * leaves the second as the whole story.
 */
export interface ExtractionDrift {
  /** Queries correct at some k and wrong at a wider one: picks the extra docs stole. */
  stolenPicks: number;
  /** Gold docs already retrieved at the narrowest k. */
  earlyHits: number;
  /** Of those, the ones answered right at the widest k. */
  earlyCorrect: number;
  /** Gold docs that only arrive at a wider k. */
  lateHits: number;
  /** Of those, the ones answered right at the widest k. */
  lateCorrect: number;
}

/**
 * Attribute the drift across a k sweep's per-query outcomes. `stolenPicks`
 * is counted over every narrow/wide pair, not just the ends, so one
 * transient flip in the middle of the sweep still shows up.
 */
export function extractionDrift(byK: ReadonlyMap<number, readonly QueryOutcome[]>): ExtractionDrift {
  const ks = [...byK.keys()].sort((a, b) => a - b);
  const narrowest = ks[0];
  const widest = ks[ks.length - 1];
  if (narrowest === undefined || widest === undefined) throw new Error("extractionDrift needs at least one k");

  let stolenPicks = 0;
  for (const outcome of byK.get(narrowest) as readonly QueryOutcome[]) {
    const correctAt = ks.map((k) => {
      const found = (byK.get(k) as readonly QueryOutcome[]).find((o) => o.queryId === outcome.queryId);
      if (found === undefined) throw new Error(`extractionDrift: no k=${k} outcome for ${outcome.queryId}`);
      return found.correct;
    });
    if (correctAt.some((correct, i) => correct && correctAt.slice(i + 1).includes(false))) stolenPicks++;
  }

  const first = new Map((byK.get(narrowest) as readonly QueryOutcome[]).map((o) => [o.queryId, o.hit]));
  const last = byK.get(widest) as readonly QueryOutcome[];
  const early = last.filter((o) => o.hit && first.get(o.queryId) === true);
  const late = last.filter((o) => o.hit && first.get(o.queryId) === false);
  return {
    stolenPicks,
    earlyHits: early.length,
    earlyCorrect: early.filter((o) => o.correct).length,
    lateHits: late.length,
    lateCorrect: late.filter((o) => o.correct).length,
  };
}
