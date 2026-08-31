import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { buildDataset } from "../src/dataset.js";
import { JUDGES } from "../src/judge.js";
import { runPairs } from "../src/protocols.js";
import { DEFAULT_SEED, runExperiment } from "../src/experiment.js";

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
    expect(row(result.champion, "primacy").championFirst).toBeLessThan(0.45);
  });

  test("both-order pulls the challenger back near truth", () => {
    expect(Math.abs(row(result.champion, "primacy").bothOrder - 0.5)).toBeLessThanOrEqual(
      0.05,
    );
  });

  test("an unbiased judge is already near truth champion-first", () => {
    expect(Math.abs(row(result.champion, "calibrated").championFirst - 0.5)).toBeLessThanOrEqual(
      0.05,
    );
  });

  // The README credits order randomization with undoing the arrangement, so
  // the champion set has to be run under randomized order. It was not: the
  // figure the prose called randomized was the both-order column.
  test("the randomized column is a randomized-order run over the champion pairs", () => {
    const dataset = buildDataset(DEFAULT_SEED);
    for (const judge of JUDGES) {
      const run = runPairs(judge, dataset.championPairs, "randomized", DEFAULT_SEED);
      let wins = 0;
      for (const v of run.verdicts) {
        if (v.verdict === "b") wins += 1;
        else if (v.verdict === "abstain") wins += 0.5;
      }
      expect(row(result.champion, judge.name).randomized).toBe(wins / run.verdicts.length);
    }
  });

  test("randomizing and swapping are two different measurements here", () => {
    const primacy = row(result.champion, "primacy");
    expect(primacy.randomized).toBeGreaterThan(primacy.championFirst + 0.03);
    expect(primacy.randomized).not.toBeCloseTo(primacy.bothOrder, 3);
  });
});

describe("README credits each number to the protocol that produced it", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf-8");
  const n = (value: number): string => value.toFixed(3);

  test("the champion table carries all three protocols", () => {
    const block = readme.split("```").find((b) => b.includes("champion-first"));
    expect(block, "README has no champion-first table").toBeDefined();
    const header = block!.trim().split("\n")[0]!;
    expect(header).toContain("randomized");
    for (const judge of ["calibrated", "primacy"]) {
      const line = block!.split("\n").find((l) => l.trimStart().startsWith(judge));
      expect(line, `champion table has no ${judge} row`).toBeDefined();
      const r = row(result.champion, judge);
      expect(line!.match(/\d\.\d{3}/g)).toEqual([
        n(r.championFirst),
        n(r.randomized),
        n(r.bothOrder),
      ]);
    }
  });

  test("the cost paragraph quotes the randomized run for randomized order", () => {
    const para = readme.split("\n\n").find((p) => p.includes("randomized order is free"));
    expect(para, "README has no cost recommendation paragraph").toBeDefined();
    const core = row(result.core, "primacy");
    // the champion figure it credits to randomizing must come from the
    // randomized run, not from the protocol that costs 2x
    expect(para).toContain(n(row(result.champion, "primacy").randomized));
    expect(para).toContain(n(core.asStoredAccuracy));
    expect(para).toContain(n(core.randomizedAccuracy));
    expect(para).toContain(n(core.effectiveAccuracy));
  });

  test("the arrangement section names the protocol behind each recovery", () => {
    const para = readme.split("\n\n").find((p) => p.includes("presenting the incumbent first"));
    expect(para, "README has no arrangement-trap paragraph").toBeDefined();
    const primacy = row(result.champion, "primacy");
    expect(para).toContain(n(primacy.championFirst));
    expect(para).toContain(n(primacy.randomized));
    expect(para).toContain(n(primacy.bothOrder));
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
