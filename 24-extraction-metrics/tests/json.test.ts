import { describe, expect, it } from "vitest";
import {
  countLeaves,
  deepEqual,
  flatten,
  genericPath,
  pathToString,
  type JsonValue,
} from "../src/json.js";
import { compare } from "../src/compare.js";
import { STRICT } from "../src/normalize.js";

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

  // Same prototype-chain hazard the comparator was fixed for: JSON.parse builds
  // ordinary objects, so a document key can be a name the object also inherits.
  // `key in b` answers yes for the inherited member, and deepEqual then scores
  // the gold value against Object.prototype instead of calling the key absent.
  describe("keys that collide with Object.prototype members", () => {
    const parse = (s: string): JsonValue => JSON.parse(s) as JsonValue;

    it("does not call a record an exact match on an inherited key", () => {
      expect(deepEqual(parse('{"__proto__":{}}'), parse('{"x":1}'))).toBe(false);
      expect(deepEqual(parse('{"a":1,"__proto__":{}}'), parse('{"a":1,"b":2}'))).toBe(false);
      expect(deepEqual(parse('{"vendor":{"__proto__":{}}}'), parse('{"vendor":{"name":"Acme"}}'))).toBe(false);
      expect(deepEqual(parse('{"items":[{"__proto__":{}}]}'), parse('{"items":[{"qty":1}]}'))).toBe(false);
    });

    it("still matches a real pair on such a name", () => {
      expect(deepEqual(parse('{"constructor":"C"}'), parse('{"constructor":"C"}'))).toBe(true);
      expect(deepEqual(parse('{"__proto__":{"a":1}}'), parse('{"__proto__":{"a":1}}'))).toBe(true);
    });

    it("agrees with the field-level comparator about which records are perfect", () => {
      const pairs: [JsonValue, JsonValue][] = [
        [parse('{"__proto__":{}}'), parse('{"x":1}')],
        [parse('{"a":1,"__proto__":{}}'), parse('{"a":1,"b":2}')],
        [parse('{"toString":"x"}'), parse('{"y":1}')],
        [parse('{"constructor":"C"}'), parse('{"constructor":"C"}')],
      ];
      for (const [gold, pred] of pairs) {
        const t = compare(gold, pred, STRICT, "index").total;
        const flawless = t.wrong === 0 && t.missing === 0 && t.spurious === 0;
        expect(deepEqual(gold, pred), JSON.stringify(gold)).toBe(flawless);
      }
    });
  });
});
