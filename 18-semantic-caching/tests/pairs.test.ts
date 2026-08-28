import { describe, expect, it } from "vitest";
import { INTENTS } from "../src/dataset.js";
import { FEATURIZERS } from "../src/features.js";
import {
  buildPairs,
  classStats,
  inversionRate,
  operatingTable,
  similarities,
  type PairClass,
} from "../src/pairs.js";

const PAIRS = buildPairs(INTENTS);

function byClassFor(name: string) {
  const featurizer = FEATURIZERS.find((candidate) => candidate.name === name);
  expect(featurizer).toBeDefined();
  return similarities(PAIRS, featurizer!);
}

describe("buildPairs", () => {
  it("builds the expected pair counts from the committed dataset", () => {
    const counts = new Map<PairClass, number>();
    for (const pair of PAIRS) counts.set(pair.pairClass, (counts.get(pair.pairClass) ?? 0) + 1);
    // 20 intents x 2 trivial, x 3 paraphrases; 10 two-intent families x 3x3
    // cross phrasings; C(20,2)=190 canonical pairs minus 10 within-family.
    expect(counts.get("trivial")).toBe(40);
    expect(counts.get("paraphrase")).toBe(60);
    expect(counts.get("near-miss")).toBe(90);
    expect(counts.get("unrelated")).toBe(180);
  });

  it("keeps near-miss pairs inside one family and unrelated pairs across families", () => {
    const familyOf = new Map<string, string>();
    for (const intent of INTENTS) {
      familyOf.set(intent.canonical, intent.family);
      for (const variant of intent.trivial) familyOf.set(variant, intent.family);
    }
    for (const pair of PAIRS) {
      if (pair.pairClass === "near-miss") {
        expect(familyOf.get(pair.a)).toBe(familyOf.get(pair.b));
        expect(pair.a).not.toBe(pair.b);
      }
      if (pair.pairClass === "unrelated") {
        expect(familyOf.get(pair.a)).not.toBe(familyOf.get(pair.b));
      }
    }
  });
});

describe("classStats", () => {
  it("computes count, mean, min, max", () => {
    const byClass = new Map<PairClass, number[]>([
      ["trivial", [0.5, 0.7, 0.9]],
      ["paraphrase", [0.2]],
    ]);
    const stats = classStats(byClass);
    const trivial = stats.find((s) => s.pairClass === "trivial")!;
    expect(trivial.count).toBe(3);
    expect(trivial.mean).toBeCloseTo(0.7, 10);
    expect(trivial.min).toBe(0.5);
    expect(trivial.max).toBe(0.9);
    const nearMiss = stats.find((s) => s.pairClass === "near-miss")!;
    expect(nearMiss.count).toBe(0);
  });
});

describe("committed-data facts both featurizers must reproduce", () => {
  for (const name of ["word", "char"]) {
    it(`${name}: ranks trivial above near-miss above paraphrase on average`, () => {
      const stats = classStats(byClassFor(name));
      const mean = (pairClass: PairClass) => stats.find((s) => s.pairClass === pairClass)!.mean;
      expect(mean("trivial")).toBeGreaterThan(mean("near-miss"));
      expect(mean("near-miss")).toBeGreaterThan(mean("paraphrase"));
      expect(mean("near-miss")).toBeGreaterThan(mean("unrelated"));
    });

    it(`${name}: inverts almost every paraphrase/near-miss comparison`, () => {
      expect(inversionRate(byClassFor(name))).toBeGreaterThan(0.9);
    });

    it(`${name}: never recalls a paraphrase at thresholds from 0.5 up`, () => {
      const table = operatingTable(byClassFor(name), [0.5, 0.7, 0.9]);
      for (const point of table) expect(point.paraphraseRecall).toBe(0);
    });
  }
});

describe("operatingTable", () => {
  it("is monotone nonincreasing in the threshold", () => {
    for (const featurizer of FEATURIZERS) {
      const thresholds = [0.5, 0.6, 0.7, 0.8, 0.9];
      const table = operatingTable(similarities(PAIRS, featurizer), thresholds);
      for (let i = 1; i < table.length; i++) {
        expect(table[i]!.trivialRecall).toBeLessThanOrEqual(table[i - 1]!.trivialRecall);
        expect(table[i]!.paraphraseRecall).toBeLessThanOrEqual(table[i - 1]!.paraphraseRecall);
        expect(table[i]!.nearMissFpr).toBeLessThanOrEqual(table[i - 1]!.nearMissFpr);
      }
    }
  });

  it("counts a pair sitting exactly on the threshold as recalled", () => {
    const byClass = new Map<PairClass, number[]>([
      ["trivial", [0.6]],
      ["paraphrase", []],
      ["near-miss", []],
    ]);
    const table = operatingTable(byClass, [0.6]);
    expect(table[0]!.trivialRecall).toBe(1);
  });
});

describe("inversionRate", () => {
  it("is 1 when every near-miss outscores every paraphrase and 0 reversed", () => {
    expect(
      inversionRate(
        new Map<PairClass, number[]>([
          ["paraphrase", [0.1, 0.2]],
          ["near-miss", [0.5]],
        ]),
      ),
    ).toBe(1);
    expect(
      inversionRate(
        new Map<PairClass, number[]>([
          ["paraphrase", [0.9]],
          ["near-miss", [0.5, 0.4]],
        ]),
      ),
    ).toBe(0);
  });

  it("is 0 when a class is empty", () => {
    expect(inversionRate(new Map())).toBe(0);
  });
});
