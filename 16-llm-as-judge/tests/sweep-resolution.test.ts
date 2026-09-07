import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { buildDataset } from "../src/dataset.js";
import { judgeDirectionStats } from "../src/direction.js";
import {
  BONUS_GRID,
  DIRECTION_SEED,
  runDirectionStudy,
} from "../src/direction-study.js";
import { makeJudge } from "../src/judge.js";

/**
 * What one authored-bonus sweep resolves, and what it does not. Each printed
 * row is a single noise draw at its own bonus, so the shape of the printed
 * curve carries the draw as well as the bonus. The dose-response underneath
 * is monotone in expectation, but one sweep of this size lands fully monotone
 * only 0.807 of the time at sigma 0.04 and 0.552 at sigma 0.12 — so monotone
 * was never a property a single sweep could establish, and the seed-7 sweep
 * is one of the draws that steps backwards.
 */

const REPLICATES = 400;
const result = runDirectionStudy(DIRECTION_SEED);
const corePairs = buildDataset(DIRECTION_SEED).corePairs;

function sweepAt(noiseSigma: number) {
  const sweep = result.sweeps.find((s) => s.noiseSigma === noiseSigma);
  if (!sweep) throw new Error(`no sweep at sigma ${noiseSigma}`);
  return sweep;
}

function leansAt(noiseSigma: number): number[] {
  return sweepAt(noiseSigma).rows.map((r) => r.positionLean);
}

function leanAtBonus(noiseSigma: number, bonus: number): number {
  const row = sweepAt(noiseSigma).rows.find((r) => r.bonus === bonus);
  if (!row) throw new Error(`no row at bonus ${bonus}`);
  return row.positionLean;
}

/** One replicate of the whole sweep: same pairs, a fresh noise identity per row. */
function replicateLeans(noiseSigma: number, k: number): number[] {
  return BONUS_GRID.map(
    (bonus) =>
      judgeDirectionStats(
        makeJudge(`swp-s${noiseSigma}-b${bonus}-k${k}`, {
          positionBonus: bonus,
          noiseSigma,
        }),
        corePairs,
      ).positionLean,
  );
}

function isMonotone(values: readonly number[]): boolean {
  return values.every((v, i) => i === 0 || v >= values[i - 1]!);
}

function mean(values: readonly number[]): number {
  return values.reduce((acc, v) => acc + v, 0) / values.length;
}

function sd(values: readonly number[]): number {
  const m = mean(values);
  return Math.sqrt(
    values.reduce((acc, v) => acc + (v - m) * (v - m), 0) / (values.length - 1),
  );
}

/** Cached because each call is 400 sweeps of 150 pairs at two calls a pair. */
const replicates = new Map<number, number[][]>();
function replicatesFor(noiseSigma: number): number[][] {
  let rows = replicates.get(noiseSigma);
  if (!rows) {
    rows = Array.from({ length: REPLICATES }, (_, k) => replicateLeans(noiseSigma, k));
    replicates.set(noiseSigma, rows);
  }
  return rows;
}

function leansByBonus(noiseSigma: number): number[][] {
  const rows = replicatesFor(noiseSigma);
  return BONUS_GRID.map((_, i) => rows.map((r) => r[i]!));
}

describe("the published sweep is not monotone", () => {
  it("sigma 0.04 steps backwards from bonus 0.03 to 0.06", () => {
    expect(leanAtBonus(0.04, 0.06)).toBeLessThan(leanAtBonus(0.04, 0.03));
    expect(isMonotone(leansAt(0.04))).toBe(false);
  });

  it("sigma 0.12 steps backwards one bonus further out, 0.06 to 0.09", () => {
    expect(leanAtBonus(0.12, 0.09)).toBeLessThan(leanAtBonus(0.12, 0.06));
    expect(isMonotone(leansAt(0.12))).toBe(false);
  });

  it("each sweep has exactly one backwards step, and it is a small one", () => {
    for (const noiseSigma of [0.04, 0.12]) {
      const leans = leansAt(noiseSigma);
      const drops = leans.filter((v, i) => i > 0 && v < leans[i - 1]!);
      expect(drops.length, `sigma ${noiseSigma}`).toBe(1);
      const worst = Math.min(...leans.map((v, i) => (i === 0 ? 0 : v - leans[i - 1]!)));
      expect(worst).toBeGreaterThan(-0.021);
    }
  });
});

describe("the rise across the grid is real even though the steps are not ordered", () => {
  it("the top of the grid clears the bottom by more than 0.25", () => {
    for (const noiseSigma of [0.04, 0.12]) {
      const leans = leansAt(noiseSigma);
      expect(leans[leans.length - 1]! - leans[0]!, `sigma ${noiseSigma}`).toBeGreaterThan(
        0.25,
      );
    }
  });

  it("coarse ordering holds where fine ordering does not", () => {
    for (const noiseSigma of [0.04, 0.12]) {
      const small = [0, 0.03].map((b) => leanAtBonus(noiseSigma, b));
      const large = [0.09, 0.12, 0.15, 0.2, 0.25, 0.3].map((b) =>
        leanAtBonus(noiseSigma, b),
      );
      expect(Math.min(...large), `sigma ${noiseSigma}`).toBeGreaterThan(Math.max(...small));
    }
  });
});

describe("the backwards step is the sweep reading its own noise", () => {
  it("one row's lean carries a null spread near 0.005 at sigma 0.04", () => {
    const nullLeans = leansByBonus(0.04)[0]!;
    expect(sd(nullLeans)).toBeCloseTo(0.0047, 3);
    expect(Math.abs(mean(nullLeans))).toBeLessThan(0.002);
  });

  it("the true gap between bonus 0.03 and 0.06 is only about twice that spread", () => {
    const byBonus = leansByBonus(0.04);
    const at003 = mean(byBonus[BONUS_GRID.indexOf(0.03)]!);
    const at006 = mean(byBonus[BONUS_GRID.indexOf(0.06)]!);
    expect(at006 - at003).toBeGreaterThan(0.01);
    expect(at006 - at003).toBeLessThan(0.016);
    // a difference of two independent rows carries sqrt(2) times a row's sd
    const stepSd = Math.sqrt(2) * sd(byBonus[0]!);
    expect(at006 - at003).toBeLessThan(3 * stepSd);
  });

  it("averaged over draws the dose-response is monotone at both sigmas", () => {
    for (const noiseSigma of [0.04, 0.12]) {
      const means = leansByBonus(noiseSigma).map(mean);
      expect(isMonotone(means), `sigma ${noiseSigma}`).toBe(true);
    }
  });

  it("a whole sweep lands monotone 0.807 of the time at sigma 0.04, 0.552 at 0.12", () => {
    const share = (noiseSigma: number) =>
      replicatesFor(noiseSigma).filter(isMonotone).length / REPLICATES;
    expect(share(0.04)).toBeCloseTo(0.807, 3);
    expect(share(0.12)).toBeCloseTo(0.552, 3);
  });
});

describe("the readme reports the sweep it actually printed", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf-8");
  /** The `## fixes` section quotes the sentence this fix retired, so it is exempt. */
  const body = readme.split("\n## fixes")[0]!;
  const flat = body.replace(/\s+/g, " ");

  it("carries the sweep table the direction study prints", () => {
    const block = readme.split("```").find((b) => b.trimStart().startsWith("bonus   0.00"));
    expect(block, "README has no authored-bonus sweep table").toBeDefined();
    const leanLine = block!.split("\n").find((l) => l.trimStart().startsWith("lean"));
    expect(leanLine!.match(/\d\.\d{3}/g)).toEqual(
      leansAt(0.04).map((v) => v.toFixed(3)),
    );
  });

  it("no longer calls that curve monotone", () => {
    expect(flat).not.toContain("monotone, zero at zero, and grows with the bonus");
    const sentence = flat.slice(flat.indexOf("bonus   0.00"));
    expect(sentence.slice(0, 400)).not.toMatch(/\bmonotone\b(?!\s+at both sigmas)/);
  });

  it("names the backwards step and why one sweep cannot order the small end", () => {
    expect(flat).toContain("not monotone");
    expect(flat).toContain("0.807");
    expect(flat).toContain("0.552");
  });

  it("the root README index row no longer claims the sweep is monotone", () => {
    const root = readFileSync(new URL("../../README.md", import.meta.url), "utf-8");
    const row = root.split("\n").find((l) => l.includes("[llm-as-judge]"));
    expect(row, "root README has no index row for 16").toBeDefined();
    expect(row).not.toContain("monotonically");
    expect(row).toContain("0.807");
  });
});
