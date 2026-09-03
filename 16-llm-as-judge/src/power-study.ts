/**
 * The power study: both-order lean vs a randomized single-call lean at an
 * equal call budget. The two statistics estimate the same quantity, because a
 * randomized single call picks one of the pair's two possible both-order
 * calls at random; what differs is variance. On a pair too clean for the
 * bonus to sway, both-order presents each answer first exactly once and
 * contributes exactly 0.5 first-wins, while a single randomized call
 * contributes a full Bernoulli draw of order luck. This study prices that
 * difference as detection power at a null-calibrated threshold, over
 * replicated seeded experiments, against authored bonuses of known size.
 */

import type { Answer, Pair } from "./dataset.js";
import { GAP_RANGE } from "./dataset.js";
import { judgeDirectionStats } from "./direction.js";
import { judgePair, LENGTH_PIVOT, makeJudge, type JudgeSpec } from "./judge.js";
import { randomizedFirstSlot } from "./protocols.js";
import { streamFor, uniform } from "./rand.js";

/** Seed for the randomized protocol's presentation order draws. */
export const ORDER_SEED = 16;

export const POWER_BUDGETS = [100, 400] as const;
export const POWER_NOISE_LEVELS = [0.04, 0.12] as const;
export const POWER_BONUSES = [0, 0.02, 0.04, 0.06, 0.09, 0.12, 0.15] as const;
export const POWER_REPLICATES = 500;
export const POWER_ALPHA = 0.05;
export const SKEW_SHARES_TENTHS = [5, 7, 9] as const;
export const SKEW_PAIR_COUNT = 2000;

export interface PowerConfig {
  replicates: number;
  budgets: readonly number[];
  noiseLevels: readonly number[];
  /** First entry must be 0: it is the null the thresholds calibrate on. */
  bonuses: readonly number[];
  alpha: number;
}

export const DEFAULT_POWER_CONFIG: PowerConfig = {
  replicates: POWER_REPLICATES,
  budgets: [...POWER_BUDGETS],
  noiseLevels: [...POWER_NOISE_LEVELS],
  bonuses: [...POWER_BONUSES],
  alpha: POWER_ALPHA,
};

/**
 * Text-free pairs for the power study. Quality draws follow the core set
 * (low in [0.15, 0.55), gap in GAP_RANGE), but the answers carry empty text
 * at the length pivot: the power judges have no length weight, so text only
 * exists in the main dataset for token accounting this study does not do.
 * goldInATenths of every 10 consecutive pairs put the better answer in slot
 * a, so balance (5) and skew (7, 9) are exact by construction.
 */
export function buildPowerPairs(
  tag: string,
  count: number,
  goldInATenths = 5,
): Pair[] {
  if (count <= 0 || count % 10 !== 0) {
    throw new Error(`count must be a positive multiple of 10, got ${count}`);
  }
  if (!Number.isInteger(goldInATenths) || goldInATenths < 0 || goldInATenths > 10) {
    throw new Error(`goldInATenths must be an integer in [0, 10], got ${goldInATenths}`);
  }
  const rng = streamFor(`power|pairs|${tag}`);
  const pairs: Pair[] = [];
  for (let i = 0; i < count; i++) {
    const id = `${tag}-${String(i).padStart(4, "0")}`;
    const betterInA = i % 10 < goldInATenths;
    const low = uniform(rng, 0.15, 0.55);
    const high = low + uniform(rng, GAP_RANGE[0], GAP_RANGE[1]);
    const answer = (slot: "a" | "b", quality: number): Answer => ({
      id: `${id}-${slot}`,
      text: "",
      tokens: LENGTH_PIVOT,
      quality,
      provenance: "rival",
    });
    pairs.push({
      id,
      question: "which answer should ship",
      a: answer("a", betterInA ? high : low),
      b: answer("b", betterInA ? low : high),
      gold: betterInA ? "a" : "b",
    });
  }
  return pairs;
}

/** Position lean from both orders of every pair: 2n calls over n pairs. */
export function bothOrderLean(judge: JudgeSpec, pairs: readonly Pair[]): number {
  return judgeDirectionStats(judge, pairs).positionLean;
}

/**
 * Position lean from one randomized-order call per pair: n calls over n
 * pairs. First-win rate minus 0.5; the order draw is seeded per pair id, so
 * pair sets with distinct ids draw independent orders.
 */
export function singleCallLean(
  judge: JudgeSpec,
  pairs: readonly Pair[],
  orderSeed: number,
): number {
  if (pairs.length === 0) throw new Error("single-call lean over an empty pair set");
  let firstWins = 0;
  for (const pair of pairs) {
    const firstSlot = randomizedFirstSlot(pair.id, orderSeed);
    if (judgePair(judge, pair, firstSlot) === firstSlot) firstWins++;
  }
  return firstWins / pairs.length - 0.5;
}

/** Position lean from one as-stored call per pair (slot a always first). */
export function asStoredLean(judge: JudgeSpec, pairs: readonly Pair[]): number {
  if (pairs.length === 0) throw new Error("as-stored lean over an empty pair set");
  let firstWins = 0;
  for (const pair of pairs) if (judgePair(judge, pair, "a") === "a") firstWins++;
  return firstWins / pairs.length - 0.5;
}

/**
 * Two-sided empirical critical value at level alpha: the smallest observed
 * |statistic| such that strictly exceeding it happens on at most an alpha
 * fraction of null replicates.
 */
export function empiricalCritical(nullStats: readonly number[], alpha: number): number {
  if (nullStats.length === 0) throw new Error("critical value over an empty null");
  if (alpha <= 0 || alpha >= 1) throw new Error(`alpha must be in (0, 1), got ${alpha}`);
  const sorted = nullStats.map(Math.abs).sort((x, y) => x - y);
  const index = Math.ceil((1 - alpha) * sorted.length) - 1;
  return sorted[Math.max(0, index)]!;
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) throw new Error("mean over an empty set");
  return values.reduce((acc, v) => acc + v, 0) / values.length;
}

export function standardDeviation(values: readonly number[]): number {
  if (values.length < 2) throw new Error("sd needs at least 2 values");
  const m = mean(values);
  const ss = values.reduce((acc, v) => acc + (v - m) * (v - m), 0);
  return Math.sqrt(ss / (values.length - 1));
}

export type DetectorName = "both-order" | "single-equal" | "single-half";

export interface DetectorCell {
  bonus: number;
  power: number;
  meanLean: number;
  sdLean: number;
}

export interface DetectorTable {
  detector: DetectorName;
  /** Judge calls this detector spends per replicate. */
  calls: number;
  pairsSeen: number;
  critical: number;
  nullSd: number;
  cells: DetectorCell[];
}

export interface BudgetBlock {
  budget: number;
  noiseSigma: number;
  detectors: DetectorTable[];
  /** (single-equal null sd / both-order null sd)^2: the call multiplier a
   * single-call design needs to match both-order's null spread. */
  varianceRatio: number;
}

export interface SkewRow {
  goldInAShare: number;
  asStored: number;
  randomized: number;
  bothOrder: number;
}

export interface PowerStudyResult {
  config: PowerConfig;
  blocks: BudgetBlock[];
  skew: SkewRow[];
}

function powerJudge(bonus: number, noiseSigma: number): JudgeSpec {
  return makeJudge(`pw-b${bonus}-n${noiseSigma}`, { positionBonus: bonus, noiseSigma });
}

function buildDetectorTable(
  detector: DetectorName,
  calls: number,
  pairsSeen: number,
  bonuses: readonly number[],
  leansByBonus: readonly number[][],
  alpha: number,
): DetectorTable {
  const nullLeans = leansByBonus[0]!;
  const critical = empiricalCritical(nullLeans, alpha);
  const nullSd = standardDeviation(nullLeans);
  const cells = bonuses.map((bonus, bi) => {
    const leans = leansByBonus[bi]!;
    return {
      bonus,
      power: leans.filter((lean) => Math.abs(lean) > critical).length / leans.length,
      meanLean: mean(leans),
      sdLean: standardDeviation(leans),
    };
  });
  return { detector, calls, pairsSeen, critical, nullSd, cells };
}

function runBudgetBlock(
  budget: number,
  noiseSigma: number,
  config: PowerConfig,
): BudgetBlock {
  if (budget % 20 !== 0) {
    throw new Error(`budget must be a multiple of 20 for exact half splits, got ${budget}`);
  }
  const half = budget / 2;
  const judges = config.bonuses.map((bonus) => powerJudge(bonus, noiseSigma));
  const leans: Record<DetectorName, number[][]> = {
    "both-order": config.bonuses.map(() => []),
    "single-equal": config.bonuses.map(() => []),
    "single-half": config.bonuses.map(() => []),
  };
  for (let r = 0; r < config.replicates; r++) {
    const pairs = buildPowerPairs(`pw-n${noiseSigma}-B${budget}-r${r}`, budget);
    const halfPairs = pairs.slice(0, half);
    for (let bi = 0; bi < judges.length; bi++) {
      const judge = judges[bi]!;
      leans["both-order"][bi]!.push(bothOrderLean(judge, halfPairs));
      leans["single-equal"][bi]!.push(singleCallLean(judge, pairs, ORDER_SEED));
      leans["single-half"][bi]!.push(singleCallLean(judge, halfPairs, ORDER_SEED));
    }
  }
  const detectors: DetectorTable[] = [
    buildDetectorTable("both-order", budget, half, config.bonuses, leans["both-order"], config.alpha),
    buildDetectorTable("single-equal", budget, budget, config.bonuses, leans["single-equal"], config.alpha),
    buildDetectorTable("single-half", half, half, config.bonuses, leans["single-half"], config.alpha),
  ];
  const bothSd = detectors[0]!.nullSd;
  const singleSd = detectors[1]!.nullSd;
  return {
    budget,
    noiseSigma,
    detectors,
    varianceRatio: (singleSd * singleSd) / (bothSd * bothSd),
  };
}

/** Smallest swept bonus reaching the target power, or null if none does. */
export function minDetectableBonus(table: DetectorTable, targetPower = 0.8): number | null {
  for (const cell of table.cells) {
    if (cell.bonus > 0 && cell.power >= targetPower) return cell.bonus;
  }
  return null;
}

function runSkewStudy(): SkewRow[] {
  const judge = makeJudge("pw-skew", {});
  return SKEW_SHARES_TENTHS.map((tenths) => {
    const pairs = buildPowerPairs(`skew-s${tenths}`, SKEW_PAIR_COUNT, tenths);
    return {
      goldInAShare: tenths / 10,
      asStored: asStoredLean(judge, pairs),
      randomized: singleCallLean(judge, pairs, ORDER_SEED),
      bothOrder: bothOrderLean(judge, pairs),
    };
  });
}

export function runPowerStudy(config: PowerConfig = DEFAULT_POWER_CONFIG): PowerStudyResult {
  if (config.bonuses[0] !== 0) {
    throw new Error("the first bonus must be 0: it is the null the thresholds calibrate on");
  }
  if (config.replicates < 2) {
    throw new Error(`need at least 2 replicates, got ${config.replicates}`);
  }
  const blocks: BudgetBlock[] = [];
  for (const noiseSigma of config.noiseLevels) {
    for (const budget of config.budgets) {
      blocks.push(runBudgetBlock(budget, noiseSigma, config));
    }
  }
  return { config, blocks, skew: runSkewStudy() };
}
