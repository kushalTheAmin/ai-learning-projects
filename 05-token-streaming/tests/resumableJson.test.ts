import { describe, expect, it } from "vitest";
import { parsePartialJson, type JsonValue, type PartialResult } from "../src/partialJson.js";
import { ResumableJsonParser } from "../src/resumableJson.js";
import { chunkOffsets } from "../src/chunker.js";
import { TOOL_ARGS } from "../src/fixture.js";
import { makeToolCallJson, replay } from "../src/resumableBench.js";

/** Feed text at the given boundaries (default: one char at a time). */
function feed(text: string, boundaries?: number[]): ResumableJsonParser {
  const parser = new ResumableJsonParser();
  const cuts = boundaries ?? Array.from({ length: text.length }, (_, i) => i + 1);
  let previous = 0;
  for (const boundary of cuts) {
    parser.push(text.slice(previous, boundary));
    previous = boundary;
  }
  return parser;
}

function asJson(result: PartialResult): string {
  return JSON.stringify(result);
}

/** view() and snapshot() must both agree with the baseline on `text`. */
function expectMatchesBaseline(text: string): void {
  const baseline = asJson(parsePartialJson(text));
  const charByChar = feed(text);
  expect(asJson(charByChar.view()), `view of ${JSON.stringify(text)}`).toBe(baseline);
  expect(asJson(charByChar.snapshot()), `snapshot of ${JSON.stringify(text)}`).toBe(baseline);
  const wholeString = feed(text, [text.length]);
  expect(asJson(wholeString.view()), `whole-push view of ${JSON.stringify(text)}`).toBe(baseline);
}

const HAND_PICKED = [
  // bare containers
  "{",
  "[",
  "[[[[[",
  "[ ",
  // literal prefixes
  '{"a": tr',
  '{"a": f',
  '{"a": nul',
  "tru",
  "null",
  // incomplete numbers
  '{"a": 12.',
  '{"a": 1e',
  '{"a": -0.',
  "[1, 2",
  "12",
  "12 ",
  "12.5e2",
  // values that have not started meaningfully
  '{"a": -',
  '{"a": ',
  // dangling keys and commas
  '{"key"',
  '{"key":',
  '{"a": "x", "b',
  '{"a":1,',
  "[1,",
  // open strings
  '"',
  '{"a":"b',
  '{"a":"b\\',
  '{"a":"x\\u26',
  '"hé ☀',
  // nesting
  '{"a": [1, {"b": "x',
  '[{"a":[',
  '{"a": {"b": 1}',
  // "__proto__" is an ordinary key, not the prototype setter
  '{"__proto__": {"polluted": true}, "ok": 1}',
  '{"__proto__": 5}',
  '{"a": {"__proto__": [1, 2]}}',
  '{"__proto__": "abc',
  '{"__proto__": {"x": 1',
  '{"__proto__": 1, "__proto__": 2}',
  // duplicate keys
  '{"a":1,"a":2',
  '{"a":1,"a":tr',
  '{"a":1,"a":trux',
  // escapes
  '{"a":"\\u2603"',
  '{"a":"q\\"w\\\\e\\/r\\b\\f\\n\\r\\t"}',
  // complete documents
  "{}",
  "[]",
  '{"a": [1, true, "x"]}',
  // whitespace tolerance
  '  {\n  "a" : [ 1 ,\t2',
  // invalid prefixes
  "",
  "   ",
  "{,",
  '{"a" 1}',
  "[}",
  '{"a":1}}',
  "hello",
  "+1",
  '{"a"1',
  "]",
  '{"a": trux, "b": 1',
  '"a" "b"',
  "1 2",
];

describe("ResumableJsonParser matches parsePartialJson", () => {
  it("on every hand-picked input, char-by-char and as one push", () => {
    for (const text of HAND_PICKED) {
      expectMatchesBaseline(text);
    }
  });

  it("on every prefix of a document with escapes, unicode, and mixed types", () => {
    const doc =
      '{"s":"a\\"b\\\\c\\u00e9\\n☀ 👍 plain tail","n":-12.5e-3,"t":true,"z":null,' +
      '"arr":[1,-0.5,"x",{"k":"v"},[]],"deep":{"o":{"k":[true,null]}}}';
    const parser = new ResumableJsonParser();
    for (let i = 0; i < doc.length; i++) {
      parser.push(doc[i] as string);
      expect(asJson(parser.view()), `prefix length ${i + 1}`).toBe(
        asJson(parsePartialJson(doc.slice(0, i + 1))),
      );
    }
    expect(parser.view().status).toBe("complete");
  });

  it("on every prefix split by UTF-16 code unit through a surrogate pair", () => {
    const doc = '{"emoji":"👍👎"}';
    for (let cut = 1; cut < doc.length; cut++) {
      const parser = new ResumableJsonParser();
      parser.push(doc.slice(0, cut));
      expect(asJson(parser.view()), `cut at ${cut}`).toBe(asJson(parsePartialJson(doc.slice(0, cut))));
      parser.push(doc.slice(cut));
      expect(parser.view()).toEqual({ status: "complete", value: { emoji: "👍👎" } });
    }
  });

  it("under 50 seeded chunkings of the fixture arguments, at every boundary", () => {
    const argsJson = JSON.stringify(TOOL_ARGS);
    for (let seed = 1; seed <= 50; seed++) {
      const parser = new ResumableJsonParser();
      let previous = 0;
      for (const boundary of chunkOffsets(argsJson.length, seed, 7)) {
        parser.push(argsJson.slice(previous, boundary));
        previous = boundary;
        expect(asJson(parser.view()), `seed ${seed} boundary ${boundary}`).toBe(
          asJson(parsePartialJson(argsJson.slice(0, boundary))),
        );
      }
    }
  });

  it("on a generated 4KB document at seeded boundaries", () => {
    const json = makeToolCallJson(4096, 99);
    for (const seed of [1, 2, 3]) {
      const parser = new ResumableJsonParser();
      let previous = 0;
      for (const boundary of chunkOffsets(json.length, seed, 24)) {
        parser.push(json.slice(previous, boundary));
        previous = boundary;
        expect(asJson(parser.view())).toBe(asJson(parsePartialJson(json.slice(0, boundary))));
      }
    }
  });

  it("on a large flat array fed in 97-char fragments", () => {
    const big = JSON.stringify(Array.from({ length: 5000 }, (_, i) => i));
    const boundaries: number[] = [];
    for (let boundary = 97; boundary < big.length; boundary += 97) boundaries.push(boundary);
    boundaries.push(big.length);
    const parser = new ResumableJsonParser();
    let previous = 0;
    for (const boundary of boundaries) {
      parser.push(big.slice(previous, boundary));
      previous = boundary;
      expect(parser.view().status).not.toBe("unparseable");
    }
    expect(parser.view()).toEqual({ status: "complete", value: JSON.parse(big) as JsonValue });
  });

  it("on deep nesting without recursion problems", () => {
    const depth = 1000;
    const parser = feed("[".repeat(depth));
    expect(asJson(parser.view())).toBe(asJson(parsePartialJson("[".repeat(depth))));
    parser.push("]".repeat(depth));
    const done = parser.snapshot();
    expect(done.status).toBe("complete");
  });
});

describe("ResumableJsonParser statuses and poisoning", () => {
  it("reports partial, then complete, across pushes", () => {
    const parser = new ResumableJsonParser();
    parser.push('{"a": [1');
    expect(parser.view()).toEqual({ status: "partial", value: { a: [1] } });
    parser.push(', 2]}');
    expect(parser.view()).toEqual({ status: "complete", value: { a: [1, 2] } });
  });

  it("is unparseable on whitespace only, then recovers when a value starts", () => {
    const parser = new ResumableJsonParser();
    parser.push("  ");
    expect(parser.view().status).toBe("unparseable");
    parser.push("{}");
    expect(parser.view()).toEqual({ status: "complete", value: {} });
  });

  it("stays unparseable once poisoned, even by later valid text", () => {
    const parser = new ResumableJsonParser();
    parser.push("]");
    expect(parser.view().status).toBe("unparseable");
    parser.push("[1]");
    expect(parser.view().status).toBe("unparseable");
    expect(parser.snapshot().status).toBe("unparseable");
  });

  it("handles empty pushes as no-ops", () => {
    const parser = new ResumableJsonParser();
    parser.push("");
    parser.push('{"a"');
    parser.push("");
    parser.push(":1}");
    expect(parser.view()).toEqual({ status: "complete", value: { a: 1 } });
  });
});

describe("view and snapshot contracts", () => {
  it("view reflects a dangling number that keeps growing", () => {
    const parser = new ResumableJsonParser();
    parser.push('{"a":1,"b":2');
    expect(parser.view()).toEqual({ status: "partial", value: { a: 1, b: 2 } });
    parser.push("4");
    expect(parser.view()).toEqual({ status: "partial", value: { a: 1, b: 24 } });
    parser.push("}");
    expect(parser.view()).toEqual({ status: "complete", value: { a: 1, b: 24 } });
  });

  it("view restores an overwritten duplicate key when the new value is still dangling", () => {
    const parser = new ResumableJsonParser();
    parser.push('{"a":1,"a":2');
    expect(parser.view()).toEqual({ status: "partial", value: { a: 2 } });
    parser.push("5}");
    expect(parser.view()).toEqual({ status: "complete", value: { a: 25 } });
  });

  it("view pops a dangling array element before the next push", () => {
    const parser = new ResumableJsonParser();
    parser.push("[1");
    expect(parser.view()).toEqual({ status: "partial", value: [1] });
    parser.push("2");
    expect(parser.view()).toEqual({ status: "partial", value: [12] });
    parser.push(",3]");
    expect(parser.view()).toEqual({ status: "complete", value: [12, 3] });
  });

  it("repeated views are stable", () => {
    const parser = new ResumableJsonParser();
    parser.push('{"a":"x');
    const first = asJson(parser.view());
    expect(asJson(parser.view())).toBe(first);
    expect(asJson(parser.view())).toBe(first);
  });

  it("a snapshot is isolated from later pushes", () => {
    const parser = new ResumableJsonParser();
    parser.push('{"a":[1');
    const snap = parser.snapshot();
    if (snap.status === "unparseable") throw new Error("expected a value");
    const frozen = asJson(snap);
    parser.push(",2],\"b\":9}");
    expect(asJson(snap)).toBe(frozen);
    expect(parser.view()).toEqual({ status: "complete", value: { a: [1, 2], b: 9 } });
  });

  it("mutating a snapshot does not corrupt the parser", () => {
    const parser = new ResumableJsonParser();
    parser.push('{"a":{"b":1');
    const snap = parser.snapshot();
    if (snap.status === "unparseable" || typeof snap.value !== "object" || snap.value === null) {
      throw new Error("expected an object snapshot");
    }
    (snap.value as { [key: string]: JsonValue })["a"] = "clobbered";
    parser.push("}}");
    expect(parser.view()).toEqual({ status: "complete", value: { a: { b: 1 } } });
  });
});

describe('"__proto__" is a key, not the prototype setter', () => {
  /** The value tree, or a thrown error when the result carries none. */
  function objectValue(result: PartialResult): { [key: string]: JsonValue } {
    if (result.status === "unparseable") throw new Error("expected a value");
    if (typeof result.value !== "object" || result.value === null || Array.isArray(result.value)) {
      throw new Error("expected an object");
    }
    return result.value as { [key: string]: JsonValue };
  }

  it("lands as an own enumerable property and leaves the prototype alone", () => {
    const value = objectValue(feed('{"__proto__": {"polluted": true}, "ok": 1}').view());
    expect(Object.prototype.hasOwnProperty.call(value, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.keys(value)).toEqual(["__proto__", "ok"]);
    // the pollution read: an inherited "polluted" would answer true here
    expect((value as { [key: string]: unknown })["polluted"]).toBeUndefined();
  });

  it("survives snapshot as an own property", () => {
    const value = objectValue(feed('{"__proto__": {"polluted": true}}').snapshot());
    expect(Object.prototype.hasOwnProperty.call(value, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  });

  it("reverts a dangling __proto__ value on the next call, like any other key", () => {
    const parser = new ResumableJsonParser();
    parser.push('{"__proto__": "ab');
    expect(asJson(parser.view())).toBe(asJson(parsePartialJson('{"__proto__": "ab')));
    parser.push('c"}');
    expect(asJson(parser.view())).toBe(asJson(parsePartialJson('{"__proto__": "abc"}')));
  });
});

describe("bench harness", () => {
  it("generates deterministic valid JSON of at least the target size", () => {
    const a = makeToolCallJson(4096, 7);
    const b = makeToolCallJson(4096, 7);
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(4096);
    expect(() => JSON.parse(a)).not.toThrow();
    expect(makeToolCallJson(4096, 8)).not.toBe(a);
  });

  it("all three replay modes end on identical complete results", () => {
    const json = makeToolCallJson(2048, 11);
    const baseline = replay(json, 5, 24, "baseline");
    const view = replay(json, 5, 24, "view");
    const snapshot = replay(json, 5, 24, "snapshot");
    expect(view.finalResult).toBe(baseline.finalResult);
    expect(snapshot.finalResult).toBe(baseline.finalResult);
    expect(baseline.finalResult.startsWith('{"status":"complete"')).toBe(true);
  });

  it("counts quadratic vs linear scan work", () => {
    const json = makeToolCallJson(2048, 11);
    const baseline = replay(json, 5, 24, "baseline");
    const view = replay(json, 5, 24, "view");
    expect(view.charsScanned).toBe(json.length);
    expect(baseline.charsScanned).toBeGreaterThan(json.length * (view.fragments / 4));
    expect(baseline.fragments).toBe(view.fragments);
  });
});
