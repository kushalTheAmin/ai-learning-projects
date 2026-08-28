/**
 * Span-level and detection metrics.
 *
 * PII: a predicted span is a true positive iff it exactly matches a gold
 * span (same start, end, type). Exact-match is the strict choice on
 * purpose; partial-credit overlap scoring is recorded as an open thread.
 *
 * Injection: threshold-swept precision/recall over item scores plus exact
 * ROC-AUC (07/12's Mann-Whitney form), so the detector is judged as a
 * ranker independent of any one cutoff.
 */

import type { PiiSpan, PiiType } from "./pii.js";

export interface PrCounts {
  tp: number;
  fp: number;
  fn: number;
}

export interface PrFScore extends PrCounts {
  precision: number;
  recall: number;
  f1: number;
}

function keyOf(span: PiiSpan): string {
  return `${span.type} ${span.start} ${span.end}`;
}

export function scorePiiSpans(gold: PiiSpan[], predicted: PiiSpan[]): PrFScore {
  const goldKeys = new Map<string, number>();
  for (const g of gold) goldKeys.set(keyOf(g), (goldKeys.get(keyOf(g)) ?? 0) + 1);
  let tp = 0;
  for (const p of predicted) {
    const k = keyOf(p);
    const remaining = goldKeys.get(k) ?? 0;
    if (remaining > 0) {
      tp++;
      goldKeys.set(k, remaining - 1);
    }
  }
  const fp = predicted.length - tp;
  const fn = gold.length - tp;
  return finalize({ tp, fp, fn });
}

export function finalize(counts: PrCounts): PrFScore {
  const { tp, fp, fn } = counts;
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { tp, fp, fn, precision, recall, f1 };
}

export function addCounts(a: PrCounts, b: PrCounts): PrCounts {
  return { tp: a.tp + b.tp, fp: a.fp + b.fp, fn: a.fn + b.fn };
}

export type PerTypeCounts = Map<PiiType, PrCounts>;

export function perTypeCounts(gold: PiiSpan[], predicted: PiiSpan[]): PerTypeCounts {
  const out: PerTypeCounts = new Map();
  const bump = (type: PiiType, field: keyof PrCounts): void => {
    const c = out.get(type) ?? { tp: 0, fp: 0, fn: 0 };
    c[field] += 1;
    out.set(type, c);
  };
  // match predictions against gold one-for-one on the exact key
  const goldRemaining = new Map<string, number>();
  for (const g of gold) goldRemaining.set(keyOf(g), (goldRemaining.get(keyOf(g)) ?? 0) + 1);
  const predMatched = new Map<string, number>();
  for (const p of predicted) {
    const k = keyOf(p);
    const remaining = goldRemaining.get(k) ?? 0;
    if (remaining > 0) {
      bump(p.type, "tp");
      goldRemaining.set(k, remaining - 1);
      predMatched.set(k, (predMatched.get(k) ?? 0) + 1);
    } else {
      bump(p.type, "fp");
    }
  }
  // any gold key left unmatched is a false negative for its type
  for (const [k, count] of goldRemaining) {
    if (count <= 0) continue;
    const type = k.split(" ")[0] as PiiType;
    for (let i = 0; i < count; i++) bump(type, "fn");
  }
  return out;
}

export interface RocPoint {
  threshold: number;
  precision: number;
  recall: number;
  fpr: number;
}

/** exact ROC-AUC via the Mann-Whitney statistic with half credit for ties */
export function rocAuc(positiveScores: number[], negativeScores: number[]): number {
  if (positiveScores.length === 0 || negativeScores.length === 0) return 0.5;
  let wins = 0;
  for (const p of positiveScores) {
    for (const n of negativeScores) {
      if (p > n) wins += 1;
      else if (p === n) wins += 0.5;
    }
  }
  return wins / (positiveScores.length * negativeScores.length);
}

export function sweepThresholds(
  positiveScores: number[],
  negativeScores: number[],
): RocPoint[] {
  const thresholds = [...new Set([...positiveScores, ...negativeScores])].sort((a, b) => a - b);
  const points: RocPoint[] = [];
  for (const t of thresholds) {
    const tp = positiveScores.filter((s) => s >= t).length;
    const fp = negativeScores.filter((s) => s >= t).length;
    const fn = positiveScores.length - tp;
    const tn = negativeScores.length - fp;
    const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
    const fpr = fp + tn === 0 ? 0 : fp / (fp + tn);
    points.push({ threshold: t, precision, recall, fpr });
  }
  return points;
}
