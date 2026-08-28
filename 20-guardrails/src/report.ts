/**
 * Pure aggregation helpers the entry point prints. Kept out of main.ts so
 * the tests can pin the numbers without capturing stdout.
 */

import type { PromptItem } from "./dataset.js";
import { detectPii, type DetectOptions } from "./pii.js";
import { scoreInjection, type ScoreOptions } from "./injection.js";
import {
  addCounts,
  finalize,
  perTypeCounts,
  rocAuc,
  scorePiiSpans,
  sweepThresholds,
  type PrCounts,
  type PrFScore,
  type RocPoint,
} from "./metrics.js";
import type { PiiItem } from "./dataset.js";
import type { PiiType } from "./pii.js";

export interface PiiEval {
  overall: PrFScore;
  perType: Map<PiiType, PrFScore>;
}

export function evalPii(corpus: PiiItem[], opts: DetectOptions = {}): PiiEval {
  let overall: PrCounts = { tp: 0, fp: 0, fn: 0 };
  const perType = new Map<PiiType, PrCounts>();
  for (const item of corpus) {
    const pred = detectPii(item.text, opts);
    overall = addCounts(overall, scorePiiSpans(item.spans, pred));
    for (const [type, counts] of perTypeCounts(item.spans, pred)) {
      perType.set(type, addCounts(perType.get(type) ?? { tp: 0, fp: 0, fn: 0 }, counts));
    }
  }
  const perTypeScored = new Map<PiiType, PrFScore>();
  for (const [type, counts] of perType) perTypeScored.set(type, finalize(counts));
  return { overall: finalize(overall), perType: perTypeScored };
}

export interface InjectionEval {
  auc: number;
  sweep: RocPoint[];
  attackScores: number[];
  benignScores: number[];
  /** per-category detection at a given threshold: fraction of attacks flagged */
  categoryDetection: Map<string, { flagged: number; total: number }>;
}

export function evalInjection(
  prompts: PromptItem[],
  scoring: ScoreOptions,
  threshold: number,
): InjectionEval {
  const attacks = prompts.filter((p) => p.kind === "attack");
  const benign = prompts.filter((p) => p.kind === "benign");
  const attackScores = attacks.map((p) => scoreInjection(p.text, scoring).score);
  const benignScores = benign.map((p) => scoreInjection(p.text, scoring).score);
  const categoryDetection = new Map<string, { flagged: number; total: number }>();
  attacks.forEach((p, i) => {
    const entry = categoryDetection.get(p.category) ?? { flagged: 0, total: 0 };
    entry.total += 1;
    if ((attackScores[i] ?? 0) >= threshold) entry.flagged += 1;
    categoryDetection.set(p.category, entry);
  });
  return {
    auc: rocAuc(attackScores, benignScores),
    sweep: sweepThresholds(attackScores, benignScores),
    attackScores,
    benignScores,
    categoryDetection,
  };
}
