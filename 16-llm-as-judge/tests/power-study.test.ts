import { describe, expect, it } from "vitest";

import { GAP_RANGE } from "../src/dataset.js";
import { LENGTH_PIVOT, makeJudge } from "../src/judge.js";
import {
  asStoredLean,
  bothOrderLean,
  buildPowerPairs,
  empiricalCritical,
  mean,
  minDetectableBonus,
  ORDER_SEED,
  runPowerStudy,
  singleCallLean,
  standardDeviation,
  type DetectorTable,
  type PowerConfig,
} from "../src/power-study.js";

const SMALL_CONFIG: PowerConfig = {
  replicates: 60,
  budgets: [40],
  noiseLevels: [0.04],
  bonuses: [0, 0.3],
  alpha: 0.05,
};

const smallResult = runPowerStudy(SMALL_CONFIG);
const smallBlock = smallResult.blocks[0]!;

function detector(name: DetectorTable["detector"]): DetectorTable {
  const table = smallBlock.detectors.find((t) => t.detector === name);
  if (!table) throw new Error(`no detector table for ${name}`);
  return table;
}

describe("buildPowerPairs", () => {
  it("refuses a count that is not a positive multiple of 10", () => {
    expect(() => buildPowerPairs("t", 0)).toThrow(/multiple of 10/);
    expect(() => buildPowerPairs("t", 15)).toThrow(/multiple of 10/);
    expect(() => buildPowerPairs("t", -10)).toThrow(/multiple of 10/);
  });

  it("refuses a goldInATenths outside [0, 10] or fractional", () => {
    expect(() => buildPowerPairs("t", 10, -1)).toThrow(/goldInATenths/);
    expect(() => buildPowerPairs("t", 10, 11)).toThrow(/goldInATenths/);
    expect(() => buildPowerPairs("t", 10, 5.5)).toThrow(/goldInATenths/);
  });

  it("is deterministic per tag and distinct across tags", () => {
    const one = buildPowerPairs("alpha", 20);
    const two = buildPowerPairs("alpha", 20);
    const other = buildPowerPairs("beta", 20);
    expect(one).toEqual(two);
    expect(one.map((p) => p.a.quality)).not.toEqual(other.map((p) => p.a.quality));
  });

  it("embeds the tag in every pair id so replicates never share rng streams", () => {
    const pairs = buildPowerPairs("r7", 10);
    for (const pair of pairs) expect(pair.id.startsWith("r7-")).toBe(true);
    const ids = new Set(pairs.map((p) => p.id));
    expect(ids.size).toBe(pairs.length);
  });

  it("holds exact balance at the default and exact skew at 9 tenths", () => {
    const balanced = buildPowerPairs("bal", 100);
    expect(balanced.filter((p) => p.gold === "a").length).toBe(50);
    const skewed = buildPowerPairs("skew", 100, 9);
    expect(skewed.filter((p) => p.gold === "a").length).toBe(90);
  });

  it("keeps balance exact on any half prefix, which the half split relies on", () => {
    const pairs = buildPowerPairs("prefix", 40);
    const half = pairs.slice(0, 20);
    expect(half.filter((p) => p.gold === "a").length).toBe(10);
  });

  it("respects the gap floor and pins answers to the length pivot", () => {
    for (const pair of buildPowerPairs("floor", 50)) {
      const gap = Math.abs(pair.a.quality - pair.b.quality);
      expect(gap).toBeGreaterThanOrEqual(GAP_RANGE[0]);
      expect(pair.a.tokens).toBe(LENGTH_PIVOT);
      expect(pair.b.tokens).toBe(LENGTH_PIVOT);
      const better = pair.gold === "a" ? pair.a : pair.b;
      const worse = pair.gold === "a" ? pair.b : pair.a;
      expect(better.quality).toBeGreaterThan(worse.quality);
    }
  });
});

describe("lean statistics", () => {
  const pairs = buildPowerPairs("stats", 200);

  it("throw on an empty pair set", () => {
    const judge = makeJudge("pw-empty");
    expect(() => singleCallLean(judge, [], ORDER_SEED)).toThrow(/empty/);
    expect(() => asStoredLean(judge, [])).toThrow(/empty/);
    expect(() => bothOrderLean(judge, [])).toThrow(/empty/);
  });

  it("read exactly zero for a noise-free unbiased judge on balanced pairs", () => {
    const judge = makeJudge("pw-oracle", { noiseSigma: 0 });
    expect(bothOrderLean(judge, pairs)).toBe(0);
    expect(asStoredLean(judge, pairs)).toBe(0);
  });

  it("read exactly +0.5 when the bonus dominates every gap", () => {
    const judge = makeJudge("pw-dominant", { noiseSigma: 0, positionBonus: 1 });
    expect(bothOrderLean(judge, pairs)).toBe(0.5);
    expect(singleCallLean(judge, pairs, ORDER_SEED)).toBe(0.5);
    expect(asStoredLean(judge, pairs)).toBe(0.5);
  });

  it("as-stored lean reads the arrangement skew as bias: exactly +0.4 at 9 tenths", () => {
    const skewed = buildPowerPairs("stats-skew", 100, 9);
    const judge = makeJudge("pw-oracle", { noiseSigma: 0 });
    expect(asStoredLean(judge, skewed)).toBeCloseTo(0.4, 12);
    expect(bothOrderLean(judge, skewed)).toBe(0);
  });

  it("a positive bonus reads as a positive lean on both estimators", () => {
    const judge = makeJudge("pw-primacy-strong", { positionBonus: 0.3 });
    expect(bothOrderLean(judge, pairs)).toBeGreaterThan(0.2);
    expect(singleCallLean(judge, pairs, ORDER_SEED)).toBeGreaterThan(0.15);
  });

  it("the order seed changes which orders the single-call estimator draws", () => {
    const judge = makeJudge("pw-noisy", { noiseSigma: 0.3 });
    const draws = new Set(
      [1, 2, 3, 4, 5].map((seed) => singleCallLean(judge, pairs, seed)),
    );
    expect(draws.size).toBeGreaterThan(1);
  });

  it("single-call lean is an unbiased draw of the both-order lean over order seeds", () => {
    const judge = makeJudge("pw-estimand", { positionBonus: 0.1, noiseSigma: 0.08 });
    const target = bothOrderLean(judge, pairs);
    const seeds = Array.from({ length: 200 }, (_, i) => i + 1);
    const averaged = mean(seeds.map((seed) => singleCallLean(judge, pairs, seed)));
    expect(Math.abs(averaged - target)).toBeLessThan(0.015);
  });
});

describe("empiricalCritical and summary helpers", () => {
  it("validates inputs", () => {
    expect(() => empiricalCritical([], 0.05)).toThrow(/empty/);
    expect(() => empiricalCritical([0.1], 0)).toThrow(/alpha/);
    expect(() => empiricalCritical([0.1], 1)).toThrow(/alpha/);
    expect(() => mean([])).toThrow(/empty/);
    expect(() => standardDeviation([0.5])).toThrow(/at least 2/);
  });

  it("picks the threshold whose strict exceedance stays within alpha", () => {
    const nulls = [0.1, -0.2, 0.3, 0.05];
    const critical = empiricalCritical(nulls, 0.25);
    expect(critical).toBe(0.2);
    const exceed = nulls.filter((v) => Math.abs(v) > critical).length;
    expect(exceed / nulls.length).toBeLessThanOrEqual(0.25);
  });

  it("computes mean and sample sd on known values", () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(standardDeviation([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3);
  });

  it("minDetectableBonus skips the null row and honors the target", () => {
    const table: DetectorTable = {
      detector: "both-order",
      calls: 10,
      pairsSeen: 5,
      critical: 0.1,
      nullSd: 0.05,
      cells: [
        { bonus: 0, power: 1, meanLean: 0, sdLean: 0.05 },
        { bonus: 0.05, power: 0.5, meanLean: 0.02, sdLean: 0.05 },
        { bonus: 0.1, power: 0.85, meanLean: 0.08, sdLean: 0.05 },
      ],
    };
    expect(minDetectableBonus(table)).toBe(0.1);
    expect(minDetectableBonus(table, 0.9)).toBeNull();
  });
});

describe("runPowerStudy", () => {
  it("validates its config", () => {
    expect(() =>
      runPowerStudy({ ...SMALL_CONFIG, bonuses: [0.1, 0.2] }),
    ).toThrow(/first bonus/);
    expect(() => runPowerStudy({ ...SMALL_CONFIG, replicates: 1 })).toThrow(/replicates/);
    expect(() => runPowerStudy({ ...SMALL_CONFIG, budgets: [30] })).toThrow(/multiple of 20/);
  });

  it("is deterministic end to end", () => {
    expect(runPowerStudy(SMALL_CONFIG)).toEqual(smallResult);
  });

  it("spends the call budget as labeled: equal for both-order and single-equal, half for single-half", () => {
    expect(detector("both-order").calls).toBe(40);
    expect(detector("both-order").pairsSeen).toBe(20);
    expect(detector("single-equal").calls).toBe(40);
    expect(detector("single-equal").pairsSeen).toBe(40);
    expect(detector("single-half").calls).toBe(20);
    expect(detector("single-half").pairsSeen).toBe(20);
  });

  it("holds the null detection rate within alpha by construction", () => {
    for (const table of smallBlock.detectors) {
      expect(table.cells[0]!.bonus).toBe(0);
      expect(table.cells[0]!.power).toBeLessThanOrEqual(SMALL_CONFIG.alpha);
    }
  });

  it("orders null spreads both-order < single-equal < single-half", () => {
    const both = detector("both-order").nullSd;
    const equal = detector("single-equal").nullSd;
    const half = detector("single-half").nullSd;
    expect(both).toBeLessThan(equal);
    expect(equal).toBeLessThan(half);
    expect(smallBlock.varianceRatio).toBeGreaterThan(1);
  });

  it("detects a large authored bonus, both-order strongest", () => {
    const both = detector("both-order").cells[1]!;
    const equal = detector("single-equal").cells[1]!;
    const half = detector("single-half").cells[1]!;
    expect(both.power).toBeGreaterThanOrEqual(0.95);
    expect(both.meanLean).toBeGreaterThan(detector("both-order").critical);
    expect(equal.power).toBeGreaterThan(half.power);
  });

  it("skew control: as-stored lean grows with the arrangement, the order-aware detectors hold near zero", () => {
    const shares = smallResult.skew.map((row) => row.goldInAShare);
    expect(shares).toEqual([0.5, 0.7, 0.9]);
    const asStored = smallResult.skew.map((row) => row.asStored);
    expect(asStored[1]!).toBeGreaterThan(asStored[0]! + 0.1);
    expect(asStored[2]!).toBeGreaterThan(asStored[1]! + 0.1);
    for (const row of smallResult.skew) {
      expect(Math.abs(row.randomized)).toBeLessThan(0.05);
      expect(Math.abs(row.bothOrder)).toBeLessThan(0.05);
    }
  });
});
