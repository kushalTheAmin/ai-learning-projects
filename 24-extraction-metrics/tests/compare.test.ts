import { describe, expect, it } from "vitest";
import { alignArrays, compare, macroF1, mergeResults, microMetrics, type Tally } from "../src/compare.js";
import type { JsonValue } from "../src/json.js";
import { FULL, STRICT } from "../src/normalize.js";

function totals(gold: JsonValue, pred: JsonValue, policy: "index" | "aligned" = "index"): Tally {
  return compare(gold, pred, STRICT, policy).total;
}

describe("compare on primitives and objects", () => {
  it("identical trees are all correct", () => {
    const tree: JsonValue = { a: 1, b: { c: "x" }, d: [true, null] };
    expect(totals(tree, structuredClone(tree))).toEqual({ correct: 4, wrong: 0, missing: 0, spurious: 0 });
  });

  it("a gold-only key is missing, a pred-only key is spurious", () => {
    expect(totals({ a: 1, b: 2 }, { a: 1, c: 3 })).toEqual({ correct: 1, wrong: 0, missing: 1, spurious: 1 });
  });

  it("a present-but-different value is one wrong, not a missing plus a spurious", () => {
    expect(totals({ a: 1 }, { a: 2 })).toEqual({ correct: 0, wrong: 1, missing: 0, spurious: 0 });
  });

  it("a structural type mismatch charges the gold subtree missing and the pred subtree spurious", () => {
    expect(totals({ a: { b: 1, c: 2 } }, { a: "flat" })).toEqual({ correct: 0, wrong: 0, missing: 2, spurious: 1 });
  });

  it("empty pred against a non-empty gold is all missing", () => {
    expect(totals({ a: 1, b: [2, 3] }, {})).toEqual({ correct: 0, wrong: 0, missing: 3, spurious: 0 });
  });

  it("empty against empty has no leaves and scores perfect", () => {
    const t = totals({}, {});
    expect(t).toEqual({ correct: 0, wrong: 0, missing: 0, spurious: 0 });
    expect(microMetrics(t)).toEqual({ precision: 1, recall: 1, f1: 1 });
  });
});

describe("array policies", () => {
  const goldItems: JsonValue = [
    { name: "a", qty: 1 },
    { name: "b", qty: 2 },
    { name: "c", qty: 3 },
  ];

  it("index policy compares positionally and charges length differences at the tail", () => {
    const t = totals([1, 2, 3], [1, 2]);
    expect(t).toEqual({ correct: 2, wrong: 0, missing: 1, spurious: 0 });
    const t2 = totals([1], [1, 9, 9]);
    expect(t2).toEqual({ correct: 1, wrong: 0, missing: 0, spurious: 2 });
  });

  it("index policy punishes a pure rotation, aligned policy recovers it fully", () => {
    const rotated = structuredClone([goldItems[1], goldItems[2], goldItems[0]]) as JsonValue;
    expect(totals(goldItems, rotated, "index").correct).toBe(0);
    expect(totals(goldItems, rotated, "aligned")).toEqual({ correct: 6, wrong: 0, missing: 0, spurious: 0 });
  });

  it("aligned policy still charges genuinely absent and invented elements", () => {
    const pred = structuredClone([goldItems[2], goldItems[0]]) as JsonValue[];
    pred.push({ name: "z", qty: 99 });
    const t = totals(goldItems, pred, "aligned");
    expect(t).toEqual({ correct: 4, wrong: 2, missing: 0, spurious: 0 });
  });

  it("identical duplicate elements pair off deterministically in document order", () => {
    const gold: JsonValue = [{ id: "same" }, { id: "same" }];
    const pairs = alignArrays(gold as JsonValue[], structuredClone(gold) as JsonValue[], STRICT);
    expect(pairs).toEqual([[0, 0], [1, 1]]);
    expect(totals(gold, structuredClone(gold), "aligned")).toEqual({ correct: 2, wrong: 0, missing: 0, spurious: 0 });
  });

  it("nested arrays align without recursing into their own alignment", () => {
    const gold: JsonValue = [{ tags: ["x", "y"] }, { tags: ["z"] }];
    const pred: JsonValue = [{ tags: ["z"] }, { tags: ["x", "y"] }];
    expect(totals(gold, pred, "aligned")).toEqual({ correct: 3, wrong: 0, missing: 0, spurious: 0 });
  });

  it("normalization applies inside alignment scoring", () => {
    const gold: JsonValue = [{ price: 1234.5 }];
    const pred: JsonValue = [{ price: "$1,234.50" }];
    expect(compare(gold, pred, FULL, "aligned").total.correct).toBe(1);
    expect(compare(gold, pred, STRICT, "aligned").total.wrong).toBe(1);
  });
});

describe("per-path accounting and macro", () => {
  it("groups leaves under generic paths with indices collapsed", () => {
    const gold: JsonValue = { items: [{ q: 1 }, { q: 2 }] };
    const pred: JsonValue = { items: [{ q: 1 }, { q: 9 }] };
    const result = compare(gold, pred, STRICT, "index");
    expect(result.perPath.get("items[].q")).toEqual({ correct: 1, wrong: 1, missing: 0, spurious: 0 });
  });

  it("macro averages only over paths that exist in gold", () => {
    const gold: JsonValue = { a: 1, b: 2 };
    const pred: JsonValue = { a: 1, b: 2, invented: "x" };
    const result = compare(gold, pred, STRICT, "index");
    const { macroF1: macro, goldPaths } = macroF1(result.perPath);
    expect(goldPaths).toBe(2);
    expect(macro).toBe(1);
    expect(microMetrics(result.total).precision).toBeLessThan(1);
  });

  it("macro punishes a rare broken field harder than micro", () => {
    const gold: JsonValue = { a: [1, 2, 3, 4, 5, 6, 7, 8, 9], rare: "k" };
    const pred: JsonValue = { a: [1, 2, 3, 4, 5, 6, 7, 8, 9], rare: "wrong" };
    const result = compare(gold, pred, STRICT, "index");
    expect(microMetrics(result.total).f1).toBeCloseTo(0.9, 10);
    expect(macroF1(result.perPath).macroF1).toBeCloseTo(0.5, 10);
  });
});

describe("microMetrics conventions", () => {
  it("computes precision over predicted leaves and recall over gold leaves", () => {
    const m = microMetrics({ correct: 6, wrong: 2, missing: 2, spurious: 4 });
    expect(m.precision).toBeCloseTo(6 / 12, 10);
    expect(m.recall).toBeCloseTo(6 / 10, 10);
    expect(m.f1).toBeCloseTo((2 * 0.5 * 0.6) / 1.1, 10);
  });

  it("an empty side scores zero there, not NaN", () => {
    expect(microMetrics({ correct: 0, wrong: 0, missing: 3, spurious: 0 })).toEqual({ precision: 0, recall: 0, f1: 0 });
    expect(microMetrics({ correct: 0, wrong: 0, missing: 0, spurious: 3 })).toEqual({ precision: 0, recall: 0, f1: 0 });
  });
});

describe("mergeResults", () => {
  it("adds totals and per-path tallies", () => {
    const a = compare({ x: 1 }, { x: 1 }, STRICT, "index");
    const b = compare({ x: 1, y: 2 }, { x: 9 }, STRICT, "index");
    mergeResults(a, b);
    expect(a.total).toEqual({ correct: 1, wrong: 1, missing: 1, spurious: 0 });
    expect(a.perPath.get("x")).toEqual({ correct: 1, wrong: 1, missing: 0, spurious: 0 });
    expect(a.perPath.get("y")).toEqual({ correct: 0, wrong: 0, missing: 1, spurious: 0 });
  });
});
