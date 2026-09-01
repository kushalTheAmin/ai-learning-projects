/**
 * Directional position statistic over both-order calls. The flip rate counts
 * how often a judge disagrees with itself when the order swaps, but it cannot
 * say why: two coin-flip calls disagree half the time with zero position
 * preference. Reading each flip's direction separates the two. A flip where
 * both calls named the answer presented first is primacy-shaped; both naming
 * the second is recency-shaped; noise produces the two shapes in equal
 * measure, so their net (the position lean) isolates the bias.
 */

import type { Pair, Slot } from "./dataset.js";
import { judgePair, type JudgeSpec } from "./judge.js";

export interface PairDirection {
  pairId: string;
  /** Winner of the call that presented slot a first. */
  forward: Slot;
  /** Winner of the call that presented slot b first. */
  reverse: Slot;
}

export type FlipKind = "none" | "toward-first" | "toward-second";

/**
 * Classify one pair's two calls. In a flip, forward and reverse disagree; if
 * the forward call picked a (its first-presented answer), the reverse call
 * picked b (its own first-presented answer), so the winner followed the
 * presentation slot both times: toward-first. The mirror case is toward-second.
 */
export function flipKind(direction: PairDirection): FlipKind {
  if (direction.forward === direction.reverse) return "none";
  return direction.forward === "a" ? "toward-first" : "toward-second";
}

export interface DirectionStats {
  pairs: number;
  /** Fraction of pairs whose two calls disagreed (either direction). */
  flipRate: number;
  towardFirstRate: number;
  towardSecondRate: number;
  /** Fraction of the 2n calls whose winner was the answer presented first. */
  firstWinRate: number;
  /**
   * firstWinRate - 0.5. An unflipped pair puts its winner first in exactly
   * one of its two calls, so consistency contributes 0.5 by construction and
   * the lean is carried entirely by the net flip direction: positive is
   * primacy, negative is recency, and symmetric noise cancels out of it.
   */
  positionLean: number;
}

/** Run both presentation orders for every pair. Same rng identities as the
 * both-order protocol, so these calls replay its verdicts exactly. */
export function measureDirections(
  judge: JudgeSpec,
  pairs: readonly Pair[],
): PairDirection[] {
  if (pairs.length === 0) throw new Error("direction measurement over an empty pair set");
  return pairs.map((pair) => ({
    pairId: pair.id,
    forward: judgePair(judge, pair, "a"),
    reverse: judgePair(judge, pair, "b"),
  }));
}

export function directionStats(directions: readonly PairDirection[]): DirectionStats {
  if (directions.length === 0) throw new Error("direction stats over an empty set");
  let towardFirst = 0;
  let towardSecond = 0;
  let firstWins = 0;
  for (const direction of directions) {
    const kind = flipKind(direction);
    if (kind === "toward-first") towardFirst++;
    else if (kind === "toward-second") towardSecond++;
    if (direction.forward === "a") firstWins++;
    if (direction.reverse === "b") firstWins++;
  }
  const n = directions.length;
  const firstWinRate = firstWins / (2 * n);
  return {
    pairs: n,
    flipRate: (towardFirst + towardSecond) / n,
    towardFirstRate: towardFirst / n,
    towardSecondRate: towardSecond / n,
    firstWinRate,
    positionLean: firstWinRate - 0.5,
  };
}

/** Convenience: measure and summarize in one step. */
export function judgeDirectionStats(
  judge: JudgeSpec,
  pairs: readonly Pair[],
): DirectionStats {
  return directionStats(measureDirections(judge, pairs));
}
