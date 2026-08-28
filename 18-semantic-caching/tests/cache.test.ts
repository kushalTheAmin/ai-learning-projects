import { describe, expect, it } from "vitest";
import { SemanticCache } from "../src/cache.js";
import { FEATURIZERS } from "../src/features.js";

const word = FEATURIZERS[0]!;

describe("SemanticCache", () => {
  it("misses on an empty cache", () => {
    const cache = new SemanticCache(word, 0.5);
    expect(cache.lookup("reset my password").kind).toBe("miss");
  });

  it("serves exact hits across case and punctuation", () => {
    const cache = new SemanticCache(word, 0.5);
    cache.insert("reset my password", "answer-a", "intent-a");
    const decision = cache.lookup("Reset my password!!");
    expect(decision.kind).toBe("exact");
    if (decision.kind === "exact") expect(decision.entry.answer).toBe("answer-a");
  });

  it("serves the exact layer even when the semantic layer is disabled", () => {
    const cache = new SemanticCache(word, Number.POSITIVE_INFINITY);
    cache.insert("cancel my subscription", "answer-b", "intent-b");
    expect(cache.lookup("cancel my subscription").kind).toBe("exact");
    expect(cache.lookup("hey cancel my subscription please").kind).toBe("miss");
  });

  it("serves a semantic hit at or above the threshold and misses below it", () => {
    const generous = new SemanticCache(word, 0.5);
    generous.insert("reset my password", "answer-a", "intent-a");
    const hit = generous.lookup("hey reset my password please");
    expect(hit.kind).toBe("semantic");
    if (hit.kind === "semantic") {
      expect(hit.entry.answer).toBe("answer-a");
      expect(hit.similarity).toBeGreaterThanOrEqual(0.5);
      expect(hit.similarity).toBeLessThan(1);
    }
    const strict = new SemanticCache(word, 0.99);
    strict.insert("reset my password", "answer-a", "intent-a");
    expect(strict.lookup("hey reset my password please").kind).toBe("miss");
  });

  it("serves the nearest entry, not the first entry past the threshold", () => {
    const cache = new SemanticCache(word, 0.1);
    cache.insert("raise my rate limit", "answer-limits", "intent-a");
    cache.insert("raise my storage quota", "answer-storage", "intent-b");
    const decision = cache.lookup("hey raise my storage quota please");
    expect(decision.kind).toBe("semantic");
    if (decision.kind === "semantic") expect(decision.entry.answer).toBe("answer-storage");
  });

  it("keeps the earliest entry on similarity ties", () => {
    const cache = new SemanticCache(word, 0.1);
    // both entries share exactly the unigram "a" with the query "a b"
    cache.insert("a c", "first", "intent-a");
    cache.insert("a d", "second", "intent-b");
    const decision = cache.lookup("a b");
    expect(decision.kind).toBe("semantic");
    if (decision.kind === "semantic") expect(decision.entry.answer).toBe("first");
  });

  it("stores one entry per normalized key", () => {
    const cache = new SemanticCache(word, 0.5);
    cache.insert("download my logs", "kept", "intent-a");
    cache.insert("Download my logs!", "ignored", "intent-b");
    expect(cache.size).toBe(1);
    const decision = cache.lookup("download my logs");
    expect(decision.kind).toBe("exact");
    if (decision.kind === "exact") expect(decision.entry.answer).toBe("kept");
  });
});
