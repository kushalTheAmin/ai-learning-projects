import { describe, expect, it } from "vitest";
import { PartialJsonError, parsePartialJson } from "../src/partial-json.js";

describe("complete documents", () => {
  it("parses scalars, containers, and nesting like JSON.parse", () => {
    for (const doc of [
      "null",
      "true",
      "false",
      '""',
      '"hé✈️の"',
      "[]",
      "{}",
      '{"a":[1,{"b":"c"},null],"d":{"e":false}}',
      '  {"padded"  :  1 }  ',
    ]) {
      const result = parsePartialJson(doc);
      expect(result.complete).toBe(true);
      expect(result.value).toEqual(JSON.parse(doc));
    }
  });

  it("parses bare numbers correctly but never marks them complete", () => {
    // A top-level number that reaches end of input is inherently ambiguous:
    // more digits could still arrive. Inside a container a delimiter closes
    // it, so numbers there do complete.
    for (const doc of ["0", "-12.5e3"]) {
      const result = parsePartialJson(doc);
      expect(result.value).toBe(JSON.parse(doc));
      expect(result.complete).toBe(false);
    }
    expect(parsePartialJson("[0, -12.5e3]")).toEqual({
      value: [0, -12.5e3],
      complete: true,
    });
  });

  it("decodes escapes including \\uXXXX and surrogate pairs", () => {
    const doc = '"line\\n tab\\t quote\\" slash\\/ \\u00e9 \\ud83d\\ude00"';
    expect(parsePartialJson(doc).value).toBe(JSON.parse(doc));
  });

  it("keeps the last value for duplicate keys, matching JSON.parse", () => {
    expect(parsePartialJson('{"a":1,"a":2}').value).toEqual({ a: 2 });
  });
});

describe("truncation policy", () => {
  const cases: [string, unknown][] = [
    ["", undefined],
    ["   ", undefined],
    ["{", {}],
    ['{"', {}],
    ['{"a', {}],
    ['{"a"', {}],
    ['{"a":', {}],
    ['{"a": ', {}],
    ['{"a":1', { a: 1 }],
    ['{"a":1,', { a: 1 }],
    ['{"a":1, "b', { a: 1 }],
    ['{"a": "par', { a: "par" }],
    ['{"a": tr', {}],
    ['{"a": nu', {}],
    ["[", []],
    ["[1", [1]],
    ["[1,", [1]],
    ['["x", "y', ["x", "y"]],
    ["[tru", []],
    ["[-", []],
    ['"hel', "hel"],
    ["tru", undefined],
    ["fals", undefined],
    ["nul", undefined],
    ["12.", 12],
    ["1e", 1],
    ["1e-", 1],
    ["-", undefined],
    ['{"n": 12.', { n: 12 }],
    ['{"deep": {"er": ["v', { deep: { er: ["v"] } }],
  ];
  it.each(cases)("%j -> %j", (prefix, expected) => {
    const result = parsePartialJson(prefix);
    expect(result.complete).toBe(false);
    expect(result.value).toEqual(expected);
  });

  it("drops a dangling backslash but keeps the string so far", () => {
    expect(parsePartialJson('{"a": "b\\').value).toEqual({ a: "b" });
  });

  it("drops an incomplete \\uXXXX escape but keeps the string so far", () => {
    expect(parsePartialJson('"caf\\u00').value).toBe("caf");
  });

  it("never marks a document complete on a trailing number", () => {
    // "12" could still become "123" — the value is usable but not final.
    const result = parsePartialJson("12");
    expect(result.value).toBe(12);
    expect(result.complete).toBe(false);
  });
});

describe("every prefix of a document is parseable", () => {
  it("returns a value or undefined for all prefixes, and monotonically reveals fields", () => {
    const doc = JSON.stringify({
      origin: "ZRH",
      note: "aisle 💺 caffè",
      n: -12.5,
      flags: [true, null, false],
      nested: { deep: { list: [1, 2, 3] } },
    });
    let previousKeys = 0;
    for (let end = 0; end <= doc.length; end++) {
      const result = parsePartialJson(doc.slice(0, end));
      expect(result.complete).toBe(end === doc.length);
      const keys =
        typeof result.value === "object" && result.value !== null
          ? Object.keys(result.value).length
          : 0;
      // Top-level fields only ever accumulate as bytes arrive.
      expect(keys).toBeGreaterThanOrEqual(previousKeys);
      previousKeys = keys;
    }
  });
});

describe("corruption is rejected, not repaired", () => {
  const invalid = [
    "]",
    "}",
    "{a:1}",
    "{'a':1}",
    '{"a" 1}',
    '{"a":1,}',
    "[1 2]",
    "[1,,2]",
    "01",
    "1.2.3",
    '"bad\\q"',
    '"bad\\u12zz"',
    "truthy",
    "nulla",
    '{"a":1}{"b":2}',
    '"unescaped\ncontrol"',
  ];
  it.each(invalid)("%j throws PartialJsonError", (doc) => {
    expect(() => parsePartialJson(doc)).toThrow(PartialJsonError);
  });

  it("reports the failure index", () => {
    try {
      parsePartialJson('{"a": qqq}');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PartialJsonError);
      expect((error as PartialJsonError).index).toBe(6);
    }
  });
});

describe("pathological input", () => {
  it("rejects nesting past the depth limit instead of blowing the stack", () => {
    const deep = "[".repeat(100_000);
    expect(() => parsePartialJson(deep)).toThrow(/max depth/);
  });

  it("accepts nesting within the depth limit", () => {
    const depth = 400;
    const doc = "[".repeat(depth) + "1" + "]".repeat(depth);
    expect(parsePartialJson(doc).complete).toBe(true);
  });

  it("handles a large flat document", () => {
    const doc = JSON.stringify(Array.from({ length: 10_000 }, (_, i) => i));
    const result = parsePartialJson(doc.slice(0, doc.length - 1));
    expect(result.complete).toBe(false);
    expect(Array.isArray(result.value)).toBe(true);
  });
});
