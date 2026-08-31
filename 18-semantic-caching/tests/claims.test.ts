import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SPREAD_CONFIGS, SPREAD_SEEDS, seedSpread } from "../src/replay.js";
import { DEFAULT_TRAFFIC } from "../src/traffic.js";

const README = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
const SPREAD = seedSpread(DEFAULT_TRAFFIC, SPREAD_SEEDS, SPREAD_CONFIGS);

function row(label: string, threshold: number) {
  const found = SPREAD.find((entry) => entry.label === label && entry.threshold === threshold);
  if (found === undefined) throw new Error(`no spread row for ${label} ${threshold}`);
  return found;
}

describe("the across-seed spread the readme now quotes", () => {
  it("measures the default seed plus 19 more", () => {
    expect(SPREAD_SEEDS.length).toBe(20);
    expect(SPREAD_SEEDS[0]).toBe(DEFAULT_TRAFFIC.seed);
    expect(SPREAD_SEEDS[SPREAD_SEEDS.length - 1]).toBe(DEFAULT_TRAFFIC.seed + 19);
  });

  it("word at 0.80 does not serve zero wrong answers in general", () => {
    const wordStrict = row("word", 0.8);
    expect(wordStrict.zeroWrongSeeds).toBe(12);
    expect(wordStrict.zeroWrongSeeds).toBeLessThan(SPREAD_SEEDS.length);
    expect(wordStrict.wrongMin).toBe(0);
    expect(wordStrict.wrongMedian).toBe(0);
    expect(wordStrict.wrongMax).toBe(9);
    expect(wordStrict.wrongMean).toBeCloseTo(1.15, 2);
  });

  it("word at 0.75 spans 0 to 25 wrong answers with a median of 2", () => {
    const wordLoose = row("word", 0.75);
    expect(wordLoose.wrongMin).toBe(0);
    expect(wordLoose.wrongMedian).toBe(2);
    expect(wordLoose.wrongMax).toBe(25);
  });

  it("char at 0.75 never serves zero, and the default seed is high in its range", () => {
    const charLoose = row("char", 0.75);
    expect(charLoose.zeroWrongSeeds).toBe(0);
    expect(charLoose.wrongMin).toBe(3);
    expect(charLoose.wrongMedian).toBe(12.5);
    expect(charLoose.wrongMax).toBe(57);
    expect(charLoose.perSeedWrong[0]).toBe(34);
  });

  it("savings barely move across seeds where wrong answers move a lot", () => {
    const wordStrict = row("word", 0.8);
    expect(wordStrict.savedMin).toBeCloseTo(0.791, 3);
    expect(wordStrict.savedMax).toBeCloseTo(0.824, 3);
  });

  it("char serves more wrong answers than word at 0.75 on every seed", () => {
    const wordLoose = row("word", 0.75);
    const charLoose = row("char", 0.75);
    for (let i = 0; i < SPREAD_SEEDS.length; i++) {
      expect(charLoose.perSeedWrong[i]).toBeGreaterThan(wordLoose.perSeedWrong[i] ?? Infinity);
    }
  });
});

describe("readme claims about the zero at 0.80", () => {
  it("never calls the zero a property of the threshold", () => {
    expect(README).not.toMatch(/serves zero wrong answers on this replay\./);
    expect(README).not.toMatch(/pinned: word at 0\.80 serving zero wrong answers,/);
  });

  it("says out loud that the zero is one seeds zero", () => {
    expect(README).toMatch(/one seeds zero/);
    expect(README).toMatch(/12 of the 20 seeds/);
    expect(README).toMatch(/up to 9/);
  });

  it("quotes the spread numbers the sweep prints", () => {
    expect(README).toMatch(/79\.1% to 82\.4%/);
    expect(README).toMatch(/3 to 57/);
    expect(README).toMatch(/0 to 25/);
  });
});
