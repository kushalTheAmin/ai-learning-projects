import { describe, expect, it } from "vitest";
import { loadPiiCorpus, loadPrompts, parseMarkedText } from "../src/dataset.js";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("parseMarkedText", () => {
  it("strips markers and records exact offsets into the clean text", () => {
    const { text, spans } = parseMarkedText("call ⟦PHONE⟧415-555-0199⟦/⟧ now");
    expect(text).toBe("call 415-555-0199 now");
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0]!.start, spans[0]!.end)).toBe("415-555-0199");
    expect(spans[0]!.type).toBe("PHONE");
  });

  it("handles multiple spans and plain text between them", () => {
    const { text, spans } = parseMarkedText("⟦EMAIL⟧a@b.com⟦/⟧ then ⟦IP⟧1.2.3.4⟦/⟧");
    expect(text).toBe("a@b.com then 1.2.3.4");
    expect(spans.map((s) => s.type)).toEqual(["EMAIL", "IP"]);
    for (const s of spans) expect(text.slice(s.start, s.end)).toBe(s.value);
  });

  it("rejects an unknown type", () => {
    expect(() => parseMarkedText("⟦NOPE⟧x⟦/⟧")).toThrow(/unknown pii type/);
  });

  it("rejects an unterminated marker", () => {
    expect(() => parseMarkedText("⟦EMAIL⟧a@b.com")).toThrow(/never closed/);
  });

  it("rejects an empty span", () => {
    expect(() => parseMarkedText("⟦EMAIL⟧⟦/⟧")).toThrow(/empty/);
  });
});

describe("loadPiiCorpus", () => {
  it("loads the committed corpus and every gold value matches its offsets", () => {
    const corpus = loadPiiCorpus("data/pii-corpus.json");
    expect(corpus.length).toBeGreaterThan(0);
    for (const item of corpus) {
      for (const span of item.spans) {
        expect(item.text.slice(span.start, span.end)).toBe(span.value);
      }
    }
  });
});

describe("loadPrompts validation", () => {
  const dir = mkdtempSync(join(tmpdir(), "guardrails-"));

  function writeTmp(name: string, data: unknown): string {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(data));
    return path;
  }

  it("loads the committed prompt set", () => {
    const prompts = loadPrompts("data/prompts.json");
    expect(prompts.some((p) => p.kind === "attack")).toBe(true);
    expect(prompts.some((p) => p.kind === "benign")).toBe(true);
  });

  it("rejects an attack with no scripted model outcome", () => {
    const path = writeTmp("a.json", [{ id: "x", kind: "attack", category: "plain-override", marked: "hi" }]);
    expect(() => loadPrompts(path)).toThrow(/no scripted model/);
  });

  it("rejects a benign item that scripts a model outcome", () => {
    const path = writeTmp("b.json", [
      { id: "x", kind: "benign", category: "benign", marked: "hi", model: { complies: true, leak: "none" } },
    ]);
    expect(() => loadPrompts(path)).toThrow(/must not script/);
  });

  it("rejects a leak without compliance", () => {
    const path = writeTmp("c.json", [
      { id: "x", kind: "attack", category: "exfiltration", marked: "hi", model: { complies: false, leak: "verbatim" } },
    ]);
    expect(() => loadPrompts(path)).toThrow(/leaks without complying/);
  });

  it("rejects duplicate ids", () => {
    const path = writeTmp("d.json", [
      { id: "x", kind: "benign", category: "benign", marked: "a" },
      { id: "x", kind: "benign", category: "benign", marked: "b" },
    ]);
    expect(() => loadPrompts(path)).toThrow(/duplicate/);
  });

  it("cleans up", () => {
    rmSync(dir, { recursive: true, force: true });
    expect(true).toBe(true);
  });
});
