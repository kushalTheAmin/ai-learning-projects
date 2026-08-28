import { describe, expect, test } from "vitest";
import { estimateTokens } from "../../08-agent-tool-loop/src/messages.js";
import {
  allPairs,
  better,
  buildDataset,
  buildText,
  CHAMPION_COUNT,
  CORE_COUNT,
  FAIL_QUALITY,
  GAP_RANGE,
  GRADING_COUNT,
  HOUSE_COUNT,
  LENGTH_COUNT,
  PASS_CUTOFF,
  PASS_QUALITY,
  PASS_RATE,
  worse,
} from "../src/dataset.js";
import { streamFor } from "../src/rand.js";

const dataset = buildDataset(7);

describe("buildDataset", () => {
  test("is deterministic for a fixed seed", () => {
    expect(buildDataset(7)).toEqual(dataset);
  });

  test("a different seed changes the data", () => {
    expect(buildDataset(8)).not.toEqual(dataset);
  });

  test("set sizes match the constants", () => {
    expect(dataset.grading).toHaveLength(GRADING_COUNT);
    expect(dataset.corePairs).toHaveLength(CORE_COUNT);
    expect(dataset.championPairs).toHaveLength(CHAMPION_COUNT);
    expect(dataset.housePairs).toHaveLength(HOUSE_COUNT);
    expect(dataset.lengthPairs).toHaveLength(LENGTH_COUNT);
  });

  test("ids are unique across every set", () => {
    const ids = [
      ...dataset.grading.map((g) => g.id),
      ...allPairs(dataset).map((p) => p.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("grading set", () => {
  test("gold pass rate is exactly PASS_RATE", () => {
    const passes = dataset.grading.filter((g) => g.goldPass).length;
    expect(passes).toBe(GRADING_COUNT * PASS_RATE);
  });

  test("labels agree with the quality cutoff and qualities stay in their bands", () => {
    for (const g of dataset.grading) {
      expect(g.goldPass).toBe(g.answer.quality >= PASS_CUTOFF);
      const [lo, hi] = g.goldPass ? PASS_QUALITY : FAIL_QUALITY;
      expect(g.answer.quality).toBeGreaterThanOrEqual(lo);
      expect(g.answer.quality).toBeLessThanOrEqual(hi);
    }
  });
});

describe("pair sets", () => {
  test("every pair's quality gap respects the floor", () => {
    for (const p of allPairs(dataset)) {
      expect(better(p).quality - worse(p).quality).toBeGreaterThanOrEqual(GAP_RANGE[0]);
    }
  });

  test("core pairs: stored order carries no signal", () => {
    const goldInA = dataset.corePairs.filter((p) => p.gold === "a").length;
    expect(goldInA * 2).toBe(CORE_COUNT);
  });

  test("champion pairs: the challenger in slot b is better in exactly half", () => {
    const challengerBetter = dataset.championPairs.filter((p) => p.gold === "b").length;
    expect(challengerBetter * 2).toBe(CHAMPION_COUNT);
  });

  test("house pairs: one house answer per pair, better in exactly half, slot balanced", () => {
    for (const p of dataset.housePairs) {
      expect([p.a.provenance, p.b.provenance].sort()).toEqual(["house", "rival"]);
    }
    const houseBetter = dataset.housePairs.filter(
      (p) => better(p).provenance === "house",
    ).length;
    const houseInA = dataset.housePairs.filter((p) => p.a.provenance === "house").length;
    expect(houseBetter * 2).toBe(HOUSE_COUNT);
    expect(houseInA * 2).toBe(HOUSE_COUNT);
  });

  test("length pairs: long answer is better in exactly half, slot balanced, lengths separate", () => {
    const longBetter = dataset.lengthPairs.filter(
      (p) => better(p).tokens > worse(p).tokens,
    ).length;
    const longInA = dataset.lengthPairs.filter((p) => p.a.tokens > p.b.tokens).length;
    expect(longBetter * 2).toBe(LENGTH_COUNT);
    expect(longInA * 2).toBe(LENGTH_COUNT);
    for (const p of dataset.lengthPairs) {
      const [short, long] = [p.a.tokens, p.b.tokens].sort((x, y) => x - y);
      expect(short).toBeLessThan(120);
      expect(long).toBeGreaterThan(160);
    }
  });
});

describe("answer text", () => {
  test("token counts are the estimator run over the committed text", () => {
    for (const p of allPairs(dataset)) {
      expect(p.a.tokens).toBe(estimateTokens(p.a.text));
      expect(p.b.tokens).toBe(estimateTokens(p.b.text));
    }
  });

  test("buildText reaches its target with bounded overshoot", () => {
    const rng = streamFor("text-test");
    for (const target of [1, 40, 120, 300]) {
      const tokens = estimateTokens(buildText(rng, target));
      expect(tokens).toBeGreaterThanOrEqual(Math.min(target, 1));
      expect(tokens).toBeLessThanOrEqual(target + 30);
    }
  });

  test("non-ascii bank sentences survive into answer text somewhere", () => {
    const all = allPairs(dataset)
      .flatMap((p) => [p.a.text, p.b.text])
      .join(" ");
    expect(/[ïé]/.test(all)).toBe(true);
  });
});
