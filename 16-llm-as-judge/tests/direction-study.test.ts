import { describe, expect, it } from "vitest";

import {
  BONUS_GRID,
  buildGapPairs,
  championFirstChallengerWinRate,
  DIRECTION_SEED,
  GAP_GRID,
  GAP_PAIR_COUNT,
  runDirectionStudy,
  SUPPRESSION_BONUSES,
} from "../src/direction-study.js";
import { makeJudge } from "../src/judge.js";

const result = runDirectionStudy(DIRECTION_SEED);

function castRow(judge: string) {
  const row = result.cast.find((r) => r.judge === judge);
  if (!row) throw new Error(`no cast row for ${judge}`);
  return row.stats;
}

describe("buildGapPairs", () => {
  it("refuses a non-positive gap and an odd count", () => {
    expect(() => buildGapPairs(DIRECTION_SEED, 0, 10)).toThrow(/gap/);
    expect(() => buildGapPairs(DIRECTION_SEED, 0.1, 7)).toThrow(/even/);
  });

  it("holds the exact gap and the half-and-half balance", () => {
    const pairs = buildGapPairs(DIRECTION_SEED, 0.15, GAP_PAIR_COUNT);
    expect(pairs.length).toBe(GAP_PAIR_COUNT);
    let challengerBetter = 0;
    for (const pair of pairs) {
      expect(Math.abs(pair.a.quality - pair.b.quality)).toBeCloseTo(0.15, 12);
      if (pair.gold === "b") challengerBetter++;
    }
    expect(challengerBetter * 2).toBe(GAP_PAIR_COUNT);
  });

  it("is deterministic per seed and distinct across seeds", () => {
    const one = buildGapPairs(3, 0.1, 4);
    const two = buildGapPairs(3, 0.1, 4);
    const other = buildGapPairs(4, 0.1, 4);
    expect(one).toEqual(two);
    expect(one.map((p) => p.a.quality)).not.toEqual(other.map((p) => p.a.quality));
  });
});

describe("championFirstChallengerWinRate", () => {
  it("throws on an empty pair set", () => {
    expect(() =>
      championFirstChallengerWinRate(makeJudge("empty-check"), []),
    ).toThrow(/empty/);
  });

  it("reads 0.5 exactly for a noise-free unbiased judge", () => {
    const pairs = buildGapPairs(DIRECTION_SEED, 0.1, GAP_PAIR_COUNT);
    const judge = makeJudge("gap-oracle", { noiseSigma: 0 });
    expect(championFirstChallengerWinRate(judge, pairs)).toBe(0.5);
  });

  it("reads 0 for a noise-free judge whose bonus exceeds the gap", () => {
    const pairs = buildGapPairs(DIRECTION_SEED, 0.1, GAP_PAIR_COUNT);
    const judge = makeJudge("gap-crusher", { noiseSigma: 0, positionBonus: 0.2 });
    expect(championFirstChallengerWinRate(judge, pairs)).toBe(0);
  });
});

describe("the cast under the lean statistic", () => {
  it("coin flips about half its pairs but carries no lean", () => {
    const coin = castRow("coin");
    expect(coin.flipRate).toBeGreaterThan(0.4);
    expect(Math.abs(coin.positionLean)).toBeLessThan(0.05);
  });

  it("primacy's flips are one-directional and its lean is half its flip rate", () => {
    const primacy = castRow("primacy");
    expect(primacy.towardFirstRate).toBeGreaterThan(0.2);
    expect(primacy.towardSecondRate).toBe(0);
    expect(primacy.positionLean).toBeCloseTo(primacy.flipRate / 2, 12);
    expect(primacy.positionLean).toBeGreaterThan(0.1);
  });

  it("every order-invariant judge sits near zero lean", () => {
    for (const judge of ["calibrated", "lenient", "verbose", "self-pref"]) {
      expect(Math.abs(castRow(judge).positionLean)).toBeLessThan(0.02);
    }
  });

  it("primacy leans harder than coin despite flipping fewer pairs", () => {
    const primacy = castRow("primacy");
    const coin = castRow("coin");
    expect(primacy.flipRate).toBeLessThan(coin.flipRate);
    expect(primacy.positionLean).toBeGreaterThan(Math.abs(coin.positionLean) + 0.05);
  });
});

describe("the authored-bonus sweep", () => {
  it("covers both noise levels over the full grid", () => {
    expect(result.sweeps.length).toBe(2);
    for (const sweep of result.sweeps) {
      expect(sweep.rows.map((r) => r.bonus)).toEqual([...BONUS_GRID]);
    }
  });

  it("zero authored bonus reads near zero lean at both noise levels", () => {
    for (const sweep of result.sweeps) {
      expect(Math.abs(sweep.rows[0]!.positionLean)).toBeLessThan(0.02);
    }
  });

  it("lean grows with the authored bonus", () => {
    for (const sweep of result.sweeps) {
      const leans = sweep.rows.map((r) => r.positionLean);
      for (let i = 1; i < leans.length; i++) {
        expect(leans[i]!).toBeGreaterThan(leans[i - 1]! - 0.02);
      }
      expect(leans[leans.length - 1]!).toBeGreaterThan(0.25);
    }
  });

  it("the same authored bonus reads larger under 3x noise when gaps dominate", () => {
    // Gaps run 0.08 to 0.4, mostly above these bonuses. A clean pair with
    // gap above bonus never flips, so extra noise hands the bonus pairs it
    // could not win alone and the lean grows. The same lean is therefore not
    // an estimate of the bonus without the noise floor and gap distribution.
    const [low, high] = result.sweeps;
    const at = (sweep: typeof low, bonus: number) =>
      sweep!.rows.find((r) => r.bonus === bonus)!.positionLean;
    for (const bonus of [0.12, 0.15, 0.2]) {
      expect(at(high, bonus)).toBeGreaterThan(at(low, bonus));
    }
  });
});

describe("the suppression map", () => {
  const winRate = (bonus: number, gap: number) => {
    const bi = result.suppression.bonuses.indexOf(bonus);
    const gi = result.suppression.gaps.indexOf(gap);
    if (bi < 0 || gi < 0) throw new Error(`no cell for bonus ${bonus} gap ${gap}`);
    return result.suppression.winRates[bi]![gi]!;
  };

  it("covers the full grid", () => {
    expect(result.suppression.bonuses).toEqual([...SUPPRESSION_BONUSES]);
    expect(result.suppression.gaps).toEqual([...GAP_GRID]);
  });

  it("zero bonus reads near the 0.500 truth at every gap", () => {
    for (const gap of GAP_GRID) {
      expect(Math.abs(winRate(0, gap) - 0.5)).toBeLessThan(0.06);
    }
  });

  it("a bonus above the gap erases the challenger almost entirely", () => {
    expect(winRate(0.2, 0.05)).toBeLessThan(0.05);
    expect(winRate(0.15, 0.05)).toBeLessThan(0.05);
  });

  it("a gap well above the bonus restores the truth", () => {
    expect(Math.abs(winRate(0.05, 0.3) - 0.5)).toBeLessThan(0.06);
    expect(Math.abs(winRate(0.1, 0.3) - 0.5)).toBeLessThan(0.06);
  });

  it("win rate falls in bonus at fixed gap and rises in gap at fixed bonus", () => {
    for (const gap of GAP_GRID) {
      for (let bi = 1; bi < SUPPRESSION_BONUSES.length; bi++) {
        expect(winRate(SUPPRESSION_BONUSES[bi]!, gap)).toBeLessThan(
          winRate(SUPPRESSION_BONUSES[bi - 1]!, gap) + 0.05,
        );
      }
    }
    for (const bonus of SUPPRESSION_BONUSES) {
      for (let gi = 1; gi < GAP_GRID.length; gi++) {
        expect(winRate(bonus, GAP_GRID[gi]!)).toBeGreaterThan(
          winRate(bonus, GAP_GRID[gi - 1]!) - 0.05,
        );
      }
    }
  });

  it("the knee sits at gap equal to bonus: about half the challengers erased", () => {
    expect(winRate(0.15, 0.15)).toBeGreaterThan(0.15);
    expect(winRate(0.15, 0.15)).toBeLessThan(0.35);
  });
});

describe("pinned headline numbers (seed 7)", () => {
  it("cast: primacy flips 43 of 150 pairs, every one toward-first", () => {
    const primacy = castRow("primacy");
    expect(primacy.flipRate).toBeCloseTo(43 / 150, 12);
    expect(primacy.towardFirstRate).toBeCloseTo(43 / 150, 12);
    expect(primacy.towardSecondRate).toBe(0);
  });

  it("cast: coin flips 76 of 150 pairs split exactly 38 and 38", () => {
    const coin = castRow("coin");
    expect(coin.flipRate).toBeCloseTo(76 / 150, 12);
    expect(coin.towardFirstRate).toBe(coin.towardSecondRate);
    expect(coin.positionLean).toBe(0);
  });

  it("suppression: bonus 0.15 leaves 18 of 200 challenger wins at gap 0.10", () => {
    const bi = result.suppression.bonuses.indexOf(0.15);
    const gi = result.suppression.gaps.indexOf(0.1);
    expect(result.suppression.winRates[bi]![gi]!).toBeCloseTo(18 / 200, 12);
  });
});

describe("determinism", () => {
  it("two runs at the same seed are identical", () => {
    expect(runDirectionStudy(DIRECTION_SEED)).toEqual(result);
  });
});
