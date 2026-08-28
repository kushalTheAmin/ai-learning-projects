/**
 * Agreement and bias metrics. Kappa is the load-bearing one: with an
 * imbalanced gold label distribution, raw accuracy pays out the base rate to
 * any judge that leans toward the majority label, and chance correction is
 * what takes that payout back.
 */

export function accuracy<T>(gold: readonly T[], pred: readonly T[]): number {
  checkPaired(gold, pred);
  let agree = 0;
  for (let i = 0; i < gold.length; i++) if (gold[i] === pred[i]) agree++;
  return agree / gold.length;
}

/**
 * Cohen's kappa for two-class labels: (po - pe) / (1 - pe), pe from the two
 * raters' marginals. 0 is chance-level agreement, 1 is perfect. When both
 * raters are constant, pe is 1 and the ratio is undefined; that is total
 * agreement with zero evidence of skill, reported as 0.
 */
export function cohensKappa(gold: readonly boolean[], pred: readonly boolean[]): number {
  checkPaired(gold, pred);
  const n = gold.length;
  let agree = 0;
  let goldPos = 0;
  let predPos = 0;
  for (let i = 0; i < n; i++) {
    if (gold[i] === pred[i]) agree++;
    if (gold[i]) goldPos++;
    if (pred[i]) predPos++;
  }
  const po = agree / n;
  const pe =
    (goldPos / n) * (predPos / n) + ((n - goldPos) / n) * ((n - predPos) / n);
  if (1 - pe < 1e-12) return 0;
  return (po - pe) / (1 - pe);
}

/** Fraction of items satisfying a predicate. */
export function rate<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  if (items.length === 0) throw new Error("rate over an empty set");
  return items.filter(predicate).length / items.length;
}

export interface DecidedStats {
  /** Fraction of items with a verdict (both orders agreed). */
  coverage: number;
  /** Accuracy over decided items only; NaN when nothing was decided. */
  decidedAccuracy: number;
  /**
   * Accuracy over all items with each abstention counted as a half point,
   * the expected value of settling abstentions by coin flip. Comparable to a
   * single-call protocol's accuracy over the same items.
   */
  effectiveAccuracy: number;
}

export function decidedStats<T>(
  gold: readonly T[],
  verdicts: readonly (T | "abstain")[],
): DecidedStats {
  checkPaired(gold, verdicts);
  let decided = 0;
  let correct = 0;
  for (let i = 0; i < gold.length; i++) {
    if (verdicts[i] === "abstain") continue;
    decided++;
    if (verdicts[i] === gold[i]) correct++;
  }
  const coverage = decided / gold.length;
  const decidedAccuracy = decided === 0 ? Number.NaN : correct / decided;
  const effectiveAccuracy = (correct + 0.5 * (gold.length - decided)) / gold.length;
  return { coverage, decidedAccuracy, effectiveAccuracy };
}

function checkPaired(gold: readonly unknown[], pred: readonly unknown[]): void {
  if (gold.length !== pred.length) {
    throw new Error(`paired arrays differ in length: ${gold.length} vs ${pred.length}`);
  }
  if (gold.length === 0) throw new Error("metric over an empty set");
}
