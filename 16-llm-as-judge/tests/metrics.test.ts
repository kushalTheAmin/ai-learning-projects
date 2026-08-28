import { describe, expect, test } from "vitest";
import { accuracy, cohensKappa, decidedStats, rate } from "../src/metrics.js";

describe("accuracy", () => {
  test("counts exact matches", () => {
    expect(accuracy(["a", "b", "a", "b"], ["a", "b", "b", "b"])).toBe(0.75);
  });

  test("throws on length mismatch and on empty input", () => {
    expect(() => accuracy([1], [1, 2])).toThrow();
    expect(() => accuracy([], [])).toThrow();
  });
});

describe("cohensKappa", () => {
  test("matches a hand-computed confusion table", () => {
    // po = 0.75; marginals 0.75 and 0.5 give pe = 0.5; kappa = 0.5
    const gold = [true, true, true, false];
    const pred = [true, true, false, false];
    expect(cohensKappa(gold, pred)).toBeCloseTo(0.5, 12);
  });

  test("perfect agreement scores 1, perfect disagreement is negative", () => {
    expect(cohensKappa([true, false, true], [true, false, true])).toBe(1);
    expect(cohensKappa([true, false], [false, true])).toBeLessThan(0);
  });

  test("an always-pass rater scores exactly 0 against imbalanced gold", () => {
    const gold = [true, true, true, false];
    const pred = [true, true, true, true];
    expect(cohensKappa(gold, pred)).toBe(0);
  });

  test("two constant raters score 0: total agreement, zero evidence", () => {
    expect(cohensKappa([true, true], [true, true])).toBe(0);
  });

  test("chance-level prediction lands near 0", () => {
    const gold = [true, false, true, false];
    const pred = [true, true, false, false];
    expect(cohensKappa(gold, pred)).toBeCloseTo(0, 12);
  });
});

describe("decidedStats", () => {
  test("splits coverage, decided accuracy and effective accuracy", () => {
    const gold = ["a", "b", "a", "b"] as const;
    const verdicts = ["a", "abstain", "b", "b"] as const;
    const stats = decidedStats(gold, verdicts);
    expect(stats.coverage).toBe(0.75);
    expect(stats.decidedAccuracy).toBeCloseTo(2 / 3, 12);
    expect(stats.effectiveAccuracy).toBe((2 + 0.5) / 4);
  });

  test("all abstentions: coverage 0, decided accuracy undefined, effective is chance", () => {
    const stats = decidedStats(["a", "b"], ["abstain", "abstain"]);
    expect(stats.coverage).toBe(0);
    expect(Number.isNaN(stats.decidedAccuracy)).toBe(true);
    expect(stats.effectiveAccuracy).toBe(0.5);
  });

  test("single decided item", () => {
    const stats = decidedStats(["a"], ["a"]);
    expect(stats.coverage).toBe(1);
    expect(stats.decidedAccuracy).toBe(1);
    expect(stats.effectiveAccuracy).toBe(1);
  });
});

describe("rate", () => {
  test("fraction satisfying the predicate", () => {
    expect(rate([1, 2, 3, 4], (x) => x % 2 === 0)).toBe(0.5);
  });

  test("throws on empty input", () => {
    expect(() => rate([], () => true)).toThrow();
  });
});
