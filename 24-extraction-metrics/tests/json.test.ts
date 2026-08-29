import { describe, expect, it } from "vitest";
import {
  countLeaves,
  deepEqual,
  flatten,
  genericPath,
  pathToString,
  type JsonValue,
} from "../src/json.js";

describe("flatten", () => {
  it("flattens nested objects and arrays in document order", () => {
    const value: JsonValue = { a: 1, b: { c: "x", d: [true, null] } };
    expect(flatten(value)).toEqual([
      { segments: ["a"], value: 1 },
      { segments: ["b", "c"], value: "x" },
      { segments: ["b", "d", 0], value: true },
      { segments: ["b", "d", 1], value: null },
    ]);
  });

  it("returns a single root leaf for a bare primitive", () => {
    expect(flatten("solo")).toEqual([{ segments: [], value: "solo" }]);
  });

  it("returns no leaves for empty containers", () => {
    expect(flatten({})).toEqual([]);
    expect(flatten([])).toEqual([]);
    expect(flatten({ a: [], b: {} })).toEqual([]);
  });

  it("keeps unicode keys and values intact", () => {
    expect(flatten({ "税率": "10%" })).toEqual([{ segments: ["税率"], value: "10%" }]);
  });
});

describe("countLeaves", () => {
  it("matches flatten's leaf count", () => {
    const value: JsonValue = { a: [1, 2, { b: null }], c: {}, d: "x" };
    expect(countLeaves(value)).toBe(flatten(value).length);
    expect(countLeaves(value)).toBe(4);
  });

  it("counts empty containers as zero", () => {
    expect(countLeaves({})).toBe(0);
    expect(countLeaves([])).toBe(0);
  });
});

describe("paths", () => {
  it("renders concrete paths with indices", () => {
    expect(pathToString(["line_items", 2, "qty"])).toBe("line_items[2].qty");
    expect(pathToString([])).toBe("(root)");
  });

  it("collapses indices in generic paths", () => {
    expect(genericPath(["line_items", 2, "qty"])).toBe("line_items[].qty");
    expect(genericPath([0, "a", 1])).toBe("[].a[]");
  });
});

describe("deepEqual", () => {
  it("is strict about types", () => {
    expect(deepEqual("42", 42)).toBe(false);
    expect(deepEqual(null, false)).toBe(false);
  });

  it("is order-sensitive for arrays and length-sensitive for keys", () => {
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual({ a: 1, b: [2, { c: null }] }, { a: 1, b: [2, { c: null }] })).toBe(true);
  });
});
