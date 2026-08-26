import { describe, expect, it } from "vitest";
import { parsePartialJson, type JsonValue } from "../src/partialJson.js";
import { TOOL_ARGS } from "../src/fixture.js";

function partial(text: string): JsonValue {
  const result = parsePartialJson(text);
  if (result.status === "unparseable") {
    throw new Error(`expected a value for ${JSON.stringify(text)}`);
  }
  return result.value;
}

describe("parsePartialJson on hand-picked prefixes", () => {
  it("closes bare containers", () => {
    expect(partial("{")).toEqual({});
    expect(partial("[")).toEqual([]);
    expect(partial("[[[[[")).toEqual([[[[[]]]]]);
    expect(partial("[ ")).toEqual([]);
  });

  it("completes an unambiguous literal prefix", () => {
    expect(partial('{"a": tr')).toEqual({ a: true });
    expect(partial('{"a": f')).toEqual({ a: false });
    expect(partial('{"a": nul')).toEqual({ a: null });
    expect(partial("tru")).toBe(true);
  });

  it("trims an incomplete number to its longest valid prefix", () => {
    expect(partial('{"a": 12.')).toEqual({ a: 12 });
    expect(partial('{"a": 1e')).toEqual({ a: 1 });
    expect(partial('{"a": -0.')).toEqual({ a: -0 });
    expect(partial("[1, 2")).toEqual([1, 2]);
  });

  it("drops a value that has not started meaningfully", () => {
    expect(partial('{"a": -')).toEqual({});
    expect(partial('{"a": ')).toEqual({});
  });

  it("drops a dangling key with no value", () => {
    expect(partial('{"key"')).toEqual({});
    expect(partial('{"key":')).toEqual({});
    expect(partial('{"a": "x", "b')).toEqual({ a: "x" });
  });

  it("drops a trailing comma", () => {
    expect(partial('{"a":1,')).toEqual({ a: 1 });
    expect(partial("[1,")).toEqual([1]);
  });

  it("closes an open string value at a safe point", () => {
    expect(partial('"')).toBe("");
    expect(partial('{"a":"b')).toEqual({ a: "b" });
    expect(partial('{"a":"b\\')).toEqual({ a: "b" });
    expect(partial('{"a":"x\\u26')).toEqual({ a: "x" });
    expect(partial('"hé ☀')).toBe("hé ☀");
  });

  it("handles nesting with mixed in-progress state", () => {
    expect(partial('{"a": [1, {"b": "x')).toEqual({ a: [1, { b: "x" }] });
    expect(partial('[{"a":[')).toEqual([{ a: [] }]);
    expect(partial('{"a": {"b": 1}')).toEqual({ a: { b: 1 } });
  });

  it("keeps the last value for duplicate keys", () => {
    expect(partial('{"a":1,"a":2')).toEqual({ a: 2 });
  });

  it("parses completed unicode escapes", () => {
    expect(partial('{"a":"\\u2603"')).toEqual({ a: "☃" });
  });

  it("reports complete documents as complete", () => {
    expect(parsePartialJson("{}")).toEqual({ status: "complete", value: {} });
    expect(parsePartialJson("[]")).toEqual({ status: "complete", value: [] });
    expect(parsePartialJson('{"a": [1, true, "x"]}')).toEqual({
      status: "complete",
      value: { a: [1, true, "x"] },
    });
    expect(parsePartialJson("12 ")).toEqual({ status: "complete", value: 12 });
  });

  it("reports a bare top-level number as partial because digits may follow", () => {
    expect(parsePartialJson("12")).toEqual({ status: "partial", value: 12 });
  });

  it("rejects text that is not a prefix of a JSON document", () => {
    for (const text of ["", "   ", "{,", '{"a" 1}', "[}", '{"a":1}}', "hello", "+1", '{"a"1', "]"]) {
      expect(parsePartialJson(text).status, text).toBe("unparseable");
    }
  });

  it("tolerates whitespace everywhere", () => {
    expect(partial('  {\n  "a" : [ 1 ,\t2')).toEqual({ a: [1, 2] });
  });
});

describe("parsePartialJson over every prefix of the fixture arguments", () => {
  const finalJson = JSON.stringify(TOOL_ARGS);
  const finalValue = JSON.parse(finalJson) as { [key: string]: JsonValue };

  it("yields a valid snapshot or unparseable for every prefix, never a throw", () => {
    let seenKeys: string[] = [];
    for (let len = 0; len <= finalJson.length; len++) {
      const result = parsePartialJson(finalJson.slice(0, len));
      if (result.status === "unparseable") continue;
      const value = result.value;
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("expected an object snapshot");
      }
      const keys = Object.keys(value);
      // keys only ever come from the real document, and never disappear
      for (const key of keys) expect(finalValue).toHaveProperty(key);
      for (const key of seenKeys) expect(keys).toContain(key);
      seenKeys = keys;
      // a partial string value must be a prefix of the final string value
      for (const key of keys) {
        const partialValue = value[key];
        const final = finalValue[key];
        if (typeof partialValue === "string" && typeof final === "string") {
          expect(final.startsWith(partialValue), `key ${key} at len ${len}`).toBe(true);
        }
      }
    }
  });

  it("parses the full document as complete and identical", () => {
    expect(parsePartialJson(finalJson)).toEqual({ status: "complete", value: finalValue });
  });

  it("is never unparseable once the first key's value has started", () => {
    const firstValueStart = finalJson.indexOf(":") + 2;
    for (let len = firstValueStart; len <= finalJson.length; len++) {
      expect(parsePartialJson(finalJson.slice(0, len)).status).not.toBe("unparseable");
    }
  });
});

describe("parsePartialJson on an oversized document", () => {
  it("handles a large array without stack or performance surprises", () => {
    const big = JSON.stringify(Array.from({ length: 5000 }, (_, i) => i));
    for (let len = 1; len <= big.length; len += 97) {
      const result = parsePartialJson(big.slice(0, len));
      expect(result.status).not.toBe("unparseable");
    }
    expect(parsePartialJson(big)).toEqual({
      status: "complete",
      value: JSON.parse(big) as JsonValue,
    });
  });
});
