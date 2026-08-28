import { describe, expect, test } from "vitest";
import { JUDGES } from "../src/judge.js";
import { runExperiment } from "../src/experiment.js";

const result = runExperiment(7);

function row<T extends { judge: string }>(rows: readonly T[], judge: string): T {
  const found = rows.find((r) => r.judge === judge);
  if (!found) throw new Error(`missing row for ${judge}`);
  return found;
}

describe("harness shape and determinism", () => {
  test("reruns are identical", () => {
    expect(runExperiment(7)).toEqual(result);
  });

  test("every judge appears in every table", () => {
    const names = JUDGES.map((j) => j.name);
    for (const table of [
      result.pointwise.rows,
      result.core,
      result.champion,
      result.house,
      result.length,
    ]) {
      expect(table.map((r) => r.judge)).toEqual(names);
    }
  });
});

describe("pointwise: accuracy pays the base rate, kappa does not", () => {
  test("gold pass rate is the designed imbalance", () => {
    expect(result.pointwise.goldPassRate).toBe(0.7);
  });

  test("always-pass collects the base rate for free and kappa returns it", () => {
    expect(result.pointwise.alwaysPass.accuracy).toBe(0.7);
    expect(result.pointwise.alwaysPass.kappa).toBe(0);
  });

  test("the lenient judge hides in accuracy and shows in kappa", () => {
    const lenient = row(result.pointwise.rows, "lenient");
    const calibrated = row(result.pointwise.rows, "calibrated");
    expect(lenient.accuracy).toBeLessThan(result.pointwise.alwaysPass.accuracy + 0.1);
    expect(lenient.kappa).toBeLessThan(calibrated.kappa - 0.5);
    expect(calibrated.accuracy).toBeGreaterThan(0.95);
  });

  test("pointwise cannot see position bias: primacy grades like calibrated", () => {
    const primacy = row(result.pointwise.rows, "primacy");
    const calibrated = row(result.pointwise.rows, "calibrated");
    expect(Math.abs(primacy.accuracy - calibrated.accuracy)).toBeLessThan(0.03);
  });

  test("coin sits at chance", () => {
    const coin = row(result.pointwise.rows, "coin");
    expect(coin.accuracy).toBeLessThan(0.65);
    expect(Math.abs(coin.kappa)).toBeLessThan(0.15);
  });
});

describe("pairwise core: flip rate is the position-bias diagnostic", () => {
  test("primacy flips far more than calibrated under order swap", () => {
    expect(row(result.core, "primacy").flipRate).toBeGreaterThan(0.2);
    expect(row(result.core, "calibrated").flipRate).toBeLessThan(0.05);
  });

  test("pairwise cannot see leniency: lenient matches calibrated", () => {
    const gap = Math.abs(
      row(result.core, "lenient").randomizedAccuracy -
        row(result.core, "calibrated").randomizedAccuracy,
    );
    expect(gap).toBeLessThan(0.05);
  });

  test("both-order decided accuracy recovers primacy to near-calibrated levels", () => {
    const primacy = row(result.core, "primacy");
    expect(primacy.decidedAccuracy).toBeGreaterThan(0.95);
    expect(primacy.coverage).toBeLessThan(0.85);
  });

  test("coin abstains on about half of both-order pairs", () => {
    const coin = row(result.core, "coin");
    expect(coin.flipRate).toBeGreaterThan(0.4);
    expect(coin.flipRate).toBeLessThan(0.6);
  });
});

describe("champion-first arrangement", () => {
  test("primacy suppresses the challenger below its true 0.5 win rate", () => {
    expect(row(result.champion, "primacy").singleOrder).toBeLessThan(0.45);
  });

  test("both-order pulls the challenger back near truth", () => {
    expect(Math.abs(row(result.champion, "primacy").bothOrder - 0.5)).toBeLessThanOrEqual(
      0.05,
    );
  });

  test("an unbiased judge is already near truth champion-first", () => {
    expect(Math.abs(row(result.champion, "calibrated").singleOrder - 0.5)).toBeLessThanOrEqual(
      0.05,
    );
  });
});

describe("self-preference survives order debiasing", () => {
  test("the self-pref judge inflates the house win rate either way", () => {
    const selfPref = row(result.house, "self-pref");
    expect(selfPref.singleOrder).toBeGreaterThan(0.55);
    expect(selfPref.bothOrder).toBeGreaterThan(0.55);
  });

  test("calibrated stays near truth", () => {
    expect(Math.abs(row(result.house, "calibrated").singleOrder - 0.5)).toBeLessThanOrEqual(
      0.05,
    );
  });
});

describe("verbosity bias", () => {
  test("the verbose judge overpicks the long answer and collapses when short is better", () => {
    const verbose = row(result.length, "verbose");
    expect(verbose.longerWinRate).toBeGreaterThan(0.7);
    expect(verbose.accuracyShorterBetter).toBeLessThan(verbose.accuracyLongerBetter - 0.3);
  });

  test("calibrated is length-blind", () => {
    const calibrated = row(result.length, "calibrated");
    expect(Math.abs(calibrated.longerWinRate - 0.5)).toBeLessThanOrEqual(0.05);
    expect(calibrated.accuracyShorterBetter).toBeGreaterThan(0.95);
  });
});

describe("protocol cost", () => {
  test("both-order costs exactly twice a single-call protocol", () => {
    const single = result.cost.find((c) => c.protocol === "as-stored")!;
    const both = result.cost.find((c) => c.protocol === "both-order")!;
    expect(single.callsPerPair).toBe(1);
    expect(both.callsPerPair).toBe(2);
    expect(both.tokensInPer1k).toBe(2 * single.tokensInPer1k);
    expect(both.usdPer1k).toBeCloseTo(2 * single.usdPer1k, 8);
  });
});
