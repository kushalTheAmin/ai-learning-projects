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
