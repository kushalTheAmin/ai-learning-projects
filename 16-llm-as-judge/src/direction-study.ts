/**
 * The direction study: the cast under the lean statistic, an authored-bonus
 * sweep that validates the lean against ground truth at two noise levels, and
 * a bonus-against-gap suppression map for the champion-first arrangement.
 * Everything is seeded and scripted; the authored position bonuses are the
 * ground truth the statistic is graded against.
 */

import { buildDataset, makeAnswer, type Pair } from "./dataset.js";
import { judgePair, JUDGES, makeJudge, type JudgeSpec } from "./judge.js";
import { streamFor, uniform } from "./rand.js";
import { judgeDirectionStats, type DirectionStats } from "./direction.js";

export const DIRECTION_SEED = 7;

/** Authored position bonuses the lean statistic is asked to detect. */
export const BONUS_GRID = [0, 0.03, 0.06, 0.09, 0.12, 0.15, 0.2, 0.25, 0.3] as const;

/** Per-answer noise levels for the sweep: the cast's default and 3x it. */
export const NOISE_LEVELS = [0.04, 0.12] as const;

/** Exact quality gaps for the suppression map's pair sets. */
export const GAP_GRID = [0.05, 0.1, 0.15, 0.2, 0.3] as const;

/** Position bonuses for the suppression map's judges. */
export const SUPPRESSION_BONUSES = [0, 0.05, 0.1, 0.15, 0.2] as const;

export const GAP_PAIR_COUNT = 200;

export interface CastRow {
  judge: string;
  stats: DirectionStats;
}

export interface SweepRow {
  bonus: number;
  flipRate: number;
  positionLean: number;
}

export interface NoiseSweep {
  noiseSigma: number;
  rows: SweepRow[];
}

export interface SuppressionMap {
  gaps: number[];
  bonuses: number[];
  /** winRates[bonusIndex][gapIndex]: challenger win rate, champion-first, truth 0.500. */
  winRates: number[][];
}

export interface DirectionStudyResult {
  seed: number;
  cast: CastRow[];
  sweeps: NoiseSweep[];
  suppression: SuppressionMap;
}

/**
 * Champion-style pairs with an exact quality gap: the incumbent always sits
 * in slot a, the challenger in b, and the challenger is better in exactly
 * half. Same construction as the champion set except the gap is a constant of
 * the set instead of a draw, so the map's gap axis is exact.
 */
export function buildGapPairs(seed: number, gap: number, count: number): Pair[] {
  if (gap <= 0) throw new Error(`gap must be positive, got ${gap}`);
  if (count <= 0 || count % 2 !== 0) {
    throw new Error(`count must be positive and even for balance, got ${count}`);
  }
  const rng = streamFor(`direction|gap|${gap}|${seed}`);
  const pairs: Pair[] = [];
  for (let i = 0; i < count; i++) {
    const id = `gap${gap}-${String(i).padStart(3, "0")}`;
    const betterInA = i % 2 === 0;
    const low = uniform(rng, 0.15, 0.55);
    const high = low + gap;
    const tokensA = Math.round(uniform(rng, 50, 250));
    const tokensB = Math.round(uniform(rng, 50, 250));
    const a = makeAnswer(`${id}-a`, rng, betterInA ? high : low, tokensA, "rival");
    const b = makeAnswer(`${id}-b`, rng, betterInA ? low : high, tokensB, "rival");
    pairs.push({
      id,
      question: "which answer should ship",
      a,
      b,
      gold: betterInA ? "a" : "b",
    });
  }
  return pairs;
}

/** Challenger (slot b) win rate under champion-first presentation: one call
 * per pair with the incumbent in the first slot, no abstentions possible. */
export function championFirstChallengerWinRate(
  judge: JudgeSpec,
  pairs: readonly Pair[],
): number {
  if (pairs.length === 0) throw new Error("win rate over an empty pair set");
  let wins = 0;
  for (const pair of pairs) if (judgePair(judge, pair, "a") === "b") wins++;
  return wins / pairs.length;
}

function runCast(pairs: readonly Pair[]): CastRow[] {
  return JUDGES.map((judge) => ({
    judge: judge.name,
    stats: judgeDirectionStats(judge, pairs),
  }));
}

function runSweeps(pairs: readonly Pair[]): NoiseSweep[] {
  return NOISE_LEVELS.map((noiseSigma) => ({
    noiseSigma,
    rows: BONUS_GRID.map((bonus) => {
      const judge = makeJudge(`lean-b${bonus}-n${noiseSigma}`, {
        positionBonus: bonus,
        noiseSigma,
      });
      const stats = judgeDirectionStats(judge, pairs);
      return { bonus, flipRate: stats.flipRate, positionLean: stats.positionLean };
    }),
  }));
}

function runSuppression(seed: number): SuppressionMap {
  const gapSets = GAP_GRID.map((gap) => buildGapPairs(seed, gap, GAP_PAIR_COUNT));
  const winRates = SUPPRESSION_BONUSES.map((bonus) => {
    const judge = makeJudge(`suppress-b${bonus}`, { positionBonus: bonus });
    return gapSets.map((pairs) => championFirstChallengerWinRate(judge, pairs));
  });
  return { gaps: [...GAP_GRID], bonuses: [...SUPPRESSION_BONUSES], winRates };
}

export function runDirectionStudy(seed: number = DIRECTION_SEED): DirectionStudyResult {
  const dataset = buildDataset(seed);
  return {
    seed,
    cast: runCast(dataset.corePairs),
    sweeps: runSweeps(dataset.corePairs),
    suppression: runSuppression(seed),
  };
}
