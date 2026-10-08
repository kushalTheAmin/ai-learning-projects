import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { buildDataset, type Slot } from "../src/dataset.js";
import { makeJudge, type JudgeSpec } from "../src/judge.js";
import { runPairs, type PairProtocol } from "../src/protocols.js";
import { DEFAULT_SEED, runExperiment } from "../src/experiment.js";

/**
 * How much randomizing the presentation order actually takes back, and on
 * which set. The champion pairs store the incumbent first every time, so the
 * arrangement carries the bias and randomizing recovers exactly half of it.
 * The core pairs store the better answer in slot a exactly half the time, so
 * as-stored already presents the better answer first as often as randomizing
 * does and there is no arrangement bias left to remove: the published
 * 0.847 to 0.887 there is one order draw, and over fresh noise draws
 * randomizing lands below as-stored rather than above it.
 */

const REPLICATES = 500;
const PRIMACY_BONUS = 0.15;
const TRUTH = 0.5;
const PUBLISHED_CORE_GAIN = 0.04;

const result = runExperiment(DEFAULT_SEED);
const corePairs = buildDataset(DEFAULT_SEED).corePairs;
const coreGold: Slot[] = corePairs.map((p) => p.gold);

function row<T extends { judge: string }>(rows: readonly T[], judge: string): T {
  const found = rows.find((r) => r.judge === judge);
  if (!found) throw new Error(`missing row for ${judge}`);
  return found;
}

function coreAccuracy(judge: JudgeSpec, protocol: PairProtocol, orderSeed: number): number {
  const run = runPairs(judge, corePairs, protocol, orderSeed);
  let agree = 0;
  for (let i = 0; i < coreGold.length; i++) {
    if (run.verdicts[i]!.verdict === coreGold[i]) agree++;
  }
  return agree / coreGold.length;
}

/** One replicate: a fresh noise identity at the cast's primacy bonus, a fresh order draw. */
function replicateGain(k: number): number {
  const judge = makeJudge(`core-order-k${k}`, { positionBonus: PRIMACY_BONUS });
  return (
    coreAccuracy(judge, "randomized", k) - coreAccuracy(judge, "as-stored", DEFAULT_SEED)
  );
}

const gains = Array.from({ length: REPLICATES }, (_, k) => replicateGain(k));

function mean(values: readonly number[]): number {
  return values.reduce((acc, v) => acc + v, 0) / values.length;
}

function sd(values: readonly number[]): number {
  const m = mean(values);
  return Math.sqrt(
    values.reduce((acc, v) => acc + (v - m) * (v - m), 0) / (values.length - 1),
  );
}

describe("the champion suppression: randomizing takes back exactly half", () => {
  const primacy = row(result.champion, "primacy");
  const suppression = TRUTH - primacy.championFirst;

  it("randomizing recovers half the suppression and both-order seven eighths", () => {
    expect(suppression).toBeCloseTo(0.12, 10);
    expect((primacy.randomized - primacy.championFirst) / suppression).toBeCloseTo(0.5, 10);
    expect((primacy.bothOrder - primacy.championFirst) / suppression).toBeCloseTo(0.875, 10);
  });

  it("both-order's extra is three quarters of what randomizing bought, not a remainder", () => {
    const fromRandomizing = primacy.randomized - primacy.championFirst;
    const extra = primacy.bothOrder - primacy.randomized;
    expect(extra / fromRandomizing).toBeCloseTo(0.75, 10);
    expect(extra).toBeGreaterThan(0.5 * fromRandomizing);
  });
});

describe("the core set has no arrangement bias for randomizing to remove", () => {
  it("its stored arrangement already puts the better answer first exactly half the time", () => {
    const betterInA = corePairs.filter((p) => p.gold === "a").length;
    expect(betterInA * 2).toBe(corePairs.length);
  });

  it("over fresh noise draws randomizing lands below as-stored, not above", () => {
    const m = mean(gains);
    const se = sd(gains) / Math.sqrt(REPLICATES);
    expect(m).toBeCloseTo(-0.0089, 3);
    expect(m + 1.96 * se).toBeLessThan(0);
  });

  it("the published 0.847 to 0.887 gain is an order draw in the tail", () => {
    const core = row(result.core, "primacy");
    expect(core.randomizedAccuracy - core.asStoredAccuracy).toBeCloseTo(
      PUBLISHED_CORE_GAIN,
      10,
    );
    expect(sd(gains)).toBeCloseTo(0.0239, 3);
    expect(PUBLISHED_CORE_GAIN / sd(gains)).toBeGreaterThan(1.5);
    const share = gains.filter((g) => g >= PUBLISHED_CORE_GAIN).length / REPLICATES;
    expect(share).toBeCloseTo(0.018, 3);
  });
});

describe("the readme sizes the recovery it credits to randomizing", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf-8");
  /** The `## fixes` section is version history and quotes the wording a fix retired. */
  const body = readme.split("\n## fixes")[0]!.replace(/\s+/g, " ");
  const root = readFileSync(new URL("../../README.md", import.meta.url), "utf-8");
  const indexRow = root.split("\n").find((l) => l.includes("[llm-as-judge]"));

  it("no longer sells randomizing as taking back most of a bias", () => {
    expect(body).not.toContain("takes back most");
    expect(indexRow, "root README has no index row for 16").toBeDefined();
    expect(indexRow).not.toContain("takes back most");
  });

  it("the arrangement paragraph sizes both protocols against the suppression", () => {
    const para = body.slice(body.indexOf("presenting the incumbent first"));
    expect(para.slice(0, 600)).toContain("half");
    expect(para.slice(0, 600)).toContain("seven eighths");
  });

  it("the cost paragraph names the core move as noise rather than recovery", () => {
    const para = body.slice(body.indexOf("randomized order is free"));
    const window = para.slice(0, 900);
    expect(window).toContain("0.847");
    expect(window).toContain("0.887");
    expect(window).toContain("one order draw");
    expect(window).toContain("0.009");
    expect(window).toContain("0.018");
  });

  it("the root index row sizes both protocols too", () => {
    expect(indexRow).toContain("half");
    expect(indexRow).toContain("seven eighths");
  });
});
