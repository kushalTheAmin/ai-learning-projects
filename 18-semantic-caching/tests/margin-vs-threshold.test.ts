/**
 * The margin-vs-threshold verdict, paired seed by seed. The readme used to
 * call word 0.75 + margin 0.10 an outright win over bare word 0.80 "on both
 * axes", off two means 1.00 and 1.15. Pinned here: the cost axis really is a
 * per-seed dominance, the risk axis is not one, and what the margin actually
 * buys on the risk side is a thinner tail.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FEATURIZERS } from "../src/features.js";
import { seedSpread, SPREAD_SEEDS, type SeedSpread } from "../src/replay.js";
import { DEFAULT_TRAFFIC } from "../src/traffic.js";

const README = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
const ROOT_README = readFileSync(fileURLToPath(new URL("../../README.md", import.meta.url)), "utf8");

/**
 * The readme minus its `## fixes` section, which quotes the sentences it
 * retired and so must be exempt from the retired-claim checks.
 */
const README_CLAIMS = README.replace(/\n## fixes\n[\s\S]*?(?=\n## )/, "\n");

const word = FEATURIZERS[0]!;

/** One run of both configs over the 20 seeds; every number below reads off it. */
const [BARE, MARGINED] = seedSpread(DEFAULT_TRAFFIC, SPREAD_SEEDS, [
  { featurizer: word, threshold: 0.8, label: "bare" },
  {
    featurizer: word,
    threshold: 0.75,
    marginPolicy: { margin: 0.1, scope: "differing-answer" },
    label: "margined",
  },
]) as [SeedSpread, SeedSpread];

const wrongDeltas = MARGINED.perSeedWrong.map((wrong, i) => wrong - (BARE.perSeedWrong[i] ?? 0));
const savedDeltas = MARGINED.perSeedSaved.map((saved, i) => saved - (BARE.perSeedSaved[i] ?? 0));

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sd(values: readonly number[]): number {
  const centre = mean(values);
  const sumSquares = values.reduce((sum, value) => sum + (value - centre) ** 2, 0);
  return Math.sqrt(sumSquares / (values.length - 1));
}

describe("the spread exposes its per-seed savings, not just the range", () => {
  it("carries one saved fraction per seed, in seed order", () => {
    expect(BARE.perSeedSaved.length).toBe(SPREAD_SEEDS.length);
    expect(MARGINED.perSeedSaved.length).toBe(SPREAD_SEEDS.length);
    expect(Math.min(...BARE.perSeedSaved)).toBeCloseTo(BARE.savedMin, 12);
    expect(Math.max(...BARE.perSeedSaved)).toBeCloseTo(BARE.savedMax, 12);
    expect(Math.min(...MARGINED.perSeedSaved)).toBeCloseTo(MARGINED.savedMin, 12);
    expect(Math.max(...MARGINED.perSeedSaved)).toBeCloseTo(MARGINED.savedMax, 12);
  });
});

describe("the cost axis: a real per-seed dominance", () => {
  it("the margin saves more than the bare threshold on every one of the 20 seeds", () => {
    for (let i = 0; i < SPREAD_SEEDS.length; i++) {
      expect(savedDeltas[i]!).toBeGreaterThan(0);
    }
  });

  it("the paired gap runs 3.71 to 5.98 points, mean 4.94 — not the two-to-four the readme read off the endpoints", () => {
    expect(Math.min(...savedDeltas)).toBeCloseTo(0.0371, 4);
    expect(Math.max(...savedDeltas)).toBeCloseTo(0.0598, 4);
    expect(mean(savedDeltas)).toBeCloseTo(0.0494, 4);
    // the endpoints the retired sentence was read off: 84.6 - 82.4 and 86.6 - 82.4
    expect(MARGINED.savedMin - BARE.savedMax).toBeCloseTo(0.022, 3);
    expect(MARGINED.savedMax - BARE.savedMax).toBeCloseTo(0.042, 3);
    // no seed's actual gap lands in that band
    expect(savedDeltas.filter((delta) => delta < 0.03).length).toBe(0);
  });
});

describe("the risk axis: a mean difference and nothing per-seed", () => {
  it("the means are the 1.00 and 1.15 the readme quotes", () => {
    expect(MARGINED.wrongMean).toBeCloseTo(1.0, 2);
    expect(BARE.wrongMean).toBeCloseTo(1.15, 2);
  });

  it("paired on the same draws the margin is better on 7 seeds, worse on 6, tied on 7", () => {
    expect(wrongDeltas.filter((delta) => delta < 0).length).toBe(7);
    expect(wrongDeltas.filter((delta) => delta > 0).length).toBe(6);
    expect(wrongDeltas.filter((delta) => delta === 0).length).toBe(7);
  });

  it("the mean difference sits inside one standard error of zero", () => {
    expect(mean(wrongDeltas)).toBeCloseTo(-0.15, 2);
    expect(sd(wrongDeltas)).toBeCloseTo(1.461, 3);
    const standardError = sd(wrongDeltas) / Math.sqrt(wrongDeltas.length);
    expect(standardError).toBeCloseTo(0.327, 3);
    expect(Math.abs(mean(wrongDeltas))).toBeLessThan(standardError);
  });

  it("two of the four risk columns the run prints go the bare threshold's way", () => {
    expect(MARGINED.zeroWrongSeeds).toBe(10);
    expect(BARE.zeroWrongSeeds).toBe(12);
    expect(MARGINED.zeroWrongSeeds).toBeLessThan(BARE.zeroWrongSeeds);
    expect(MARGINED.wrongMedian).toBe(0.5);
    expect(BARE.wrongMedian).toBe(0);
    expect(MARGINED.wrongMedian).toBeGreaterThan(BARE.wrongMedian);
  });
});

describe("what the margin does buy on the risk side: the tail", () => {
  it("drops the worst seed 9 to 6 and the seeds serving 3 or more from 3 to 1", () => {
    expect(BARE.wrongMax).toBe(9);
    expect(MARGINED.wrongMax).toBe(6);
    expect(BARE.perSeedWrong.filter((wrong) => wrong >= 3).length).toBe(3);
    expect(MARGINED.perSeedWrong.filter((wrong) => wrong >= 3).length).toBe(1);
  });

  it("where the margin is worse it is worse by 1 or 2, where it is better it is better by up to 3", () => {
    expect(Math.max(...wrongDeltas)).toBe(2);
    expect(Math.min(...wrongDeltas)).toBe(-3);
  });
});

describe("the readmes carry the split verdict, not the outright one", () => {
  it("the retired claims are gone from both", () => {
    expect(README_CLAIMS).not.toMatch(/beats the threshold as a knob outright/);
    expect(README_CLAIMS).not.toMatch(/two to four points more savings/);
    expect(README_CLAIMS).not.toMatch(/less risk and two to four points/);
    // the fixes entry is where those sentences are allowed to survive
    expect(README).toMatch(/two to four points more savings/);
    expect(README_CLAIMS.length).toBeLessThan(README.length);
    expect(ROOT_README).not.toMatch(/dominates bare word 0\.80 on both axes/);
    expect(ROOT_README).not.toMatch(/the margin is the better knob than the threshold it replaces/);
  });

  it("the project readme names the paired numbers", () => {
    expect(README).toMatch(/3\.71 to 5\.98 points/);
    expect(README).toMatch(/7 seeds, more on 6/);
    expect(README).toMatch(/10 seeds of 20/);
    expect(README).toMatch(/9 to 6/);
  });

  it("the root readme row splits the two axes too", () => {
    expect(ROOT_README).toMatch(/3\.71 to 5\.98 points/);
    expect(ROOT_README).toMatch(/10\/20 vs 12\/20/);
  });
});
