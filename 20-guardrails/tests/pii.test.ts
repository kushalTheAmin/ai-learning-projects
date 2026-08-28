import { describe, expect, it } from "vitest";
import { detectPii, resolveOverlaps, type PiiSpan } from "../src/pii.js";
import { loadPiiCorpus } from "../src/dataset.js";
import { evalPii } from "../src/report.js";

function types(text: string): string[] {
  return detectPii(text).map((s) => s.type);
}

describe("detectPii per type", () => {
  it("finds emails including plus tags and multi-label domains", () => {
    const spans = detectPii("write billing+acme@mail-server.co.uk about it");
    expect(spans).toHaveLength(1);
    expect(spans[0]?.type).toBe("EMAIL");
    expect(spans[0]?.value).toBe("billing+acme@mail-server.co.uk");
  });

  it("finds formatted phones but not a bare digit run", () => {
    expect(types("call 415-555-0199 now")).toEqual(["PHONE"]);
    expect(types("dotted 212.555.0147.")).toEqual(["PHONE"]);
    expect(types("intl +44 20 7946 0958 line")).toEqual(["PHONE"]);
    expect(types("text 4155550199 direct")).toEqual([]);
  });

  it("finds valid dash-formatted ssns and rejects invalid area/group/serial", () => {
    expect(types("ssn 078-05-1120 filed")).toEqual(["SSN"]);
    expect(types("ssn 000-45-6789 placeholder")).toEqual([]);
    expect(types("ssn 666-45-6789 placeholder")).toEqual([]);
    expect(types("ssn 900-45-6789 placeholder")).toEqual([]);
    expect(types("ssn 123-00-6789 placeholder")).toEqual([]);
    expect(types("ssn 123-45-0000 placeholder")).toEqual([]);
  });

  it("finds luhn-valid known-prefix cards and rejects the rest", () => {
    expect(types("card 4111 1111 1111 1111 ok")).toEqual(["CARD"]);
    expect(types("card 4000 1234 5678 9010 ref")).toEqual([]); // valid prefix, fails luhn
    expect(types("id 1234 5678 9012 3456 scan")).toEqual([]); // no known prefix
  });

  it("respects the luhn option toggle", () => {
    expect(detectPii("ref 4000123456789010 here", { luhn: false }).map((s) => s.type)).toEqual(["CARD"]);
    expect(detectPii("ref 4000123456789010 here", { luhn: true }).map((s) => s.type)).toEqual([]);
  });

  it("finds ipv4 and rejects an octet over 255", () => {
    expect(types("from 192.168.1.24 host")).toEqual(["IP"]);
    expect(types("sku 10.42.7.301 code")).toEqual([]);
  });

  it("finds secrets by known prefix and by entropy, respecting the gate", () => {
    expect(types("key sk-abc123DEF456ghi789JKL012mno345 set")).toEqual(["SECRET"]);
    expect(types("tok xQ9zR2mK7bV4nT1pL8wY3jH6dF0sA5cG auth")).toEqual(["SECRET"]);
    expect(types("seed aaaaaaaaaa1111111111 fill")).toEqual([]); // below entropy gate
    expect(detectPii("seed aaaaaaaaaa1111111111 fill", { entropyThreshold: 0 }).map((s) => s.type)).toEqual([
      "SECRET",
    ]);
  });
});

describe("detectPii structure", () => {
  it("returns exact character offsets", () => {
    const text = "mail me at a@b.com please";
    const span = detectPii(text)[0];
    expect(span).toBeDefined();
    expect(text.slice(span!.start, span!.end)).toBe("a@b.com");
  });

  it("counts offsets in utf-16 code units past astral and accented characters", () => {
    const text = "café ☕ ping jozef@bistro.example now";
    const span = detectPii(text).find((s) => s.type === "EMAIL");
    expect(span).toBeDefined();
    expect(text.slice(span!.start, span!.end)).toBe("jozef@bistro.example");
  });

  it("detects every occurrence of a repeated value", () => {
    const spans = detectPii("a@b.com and later a@b.com again");
    expect(spans.filter((s) => s.type === "EMAIL")).toHaveLength(2);
  });

  it("handles empty and pii-free input", () => {
    expect(detectPii("")).toEqual([]);
    expect(detectPii("just a normal sentence with no identifiers")).toEqual([]);
  });

  it("prefers the higher-priority type when candidates overlap", () => {
    const spans: PiiSpan[] = [
      { start: 0, end: 16, type: "CARD", value: "4111111111111111" },
      { start: 0, end: 16, type: "SECRET", value: "4111111111111111" },
    ];
    const kept = resolveOverlaps(spans);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.type).toBe("CARD");
  });

  it("keeps the earlier of two overlapping spans", () => {
    const spans: PiiSpan[] = [
      { start: 0, end: 10, type: "EMAIL", value: "a@b.com xx" },
      { start: 5, end: 20, type: "SECRET", value: "xxxxxxxxxxxxxxx" },
    ];
    expect(resolveOverlaps(spans)).toHaveLength(1);
  });
});

describe("detectPii on the committed corpus", () => {
  const corpus = loadPiiCorpus("data/pii-corpus.json");

  it("scores exactly precision 1.0 recall 1.0 with all checks on", () => {
    const evalResult = evalPii(corpus);
    expect(evalResult.overall.precision).toBe(1);
    expect(evalResult.overall.recall).toBe(1);
    expect(evalResult.overall.tp).toBe(31);
    expect(evalResult.overall.fp).toBe(0);
    expect(evalResult.overall.fn).toBe(0);
  });

  it("gains one false positive each when luhn or the entropy gate is disabled", () => {
    expect(evalPii(corpus, { luhn: false }).overall.fp).toBe(1);
    expect(evalPii(corpus, { entropyThreshold: 0 }).overall.fp).toBe(1);
  });
});
