import { describe, expect, it } from "vitest";
import { charVector, cosine, normalizeText, wordVector } from "../src/features.js";

function norm(vector: Map<number, number>): number {
  let sum = 0;
  for (const weight of vector.values()) sum += weight * weight;
  return Math.sqrt(sum);
}

describe("normalizeText", () => {
  it("lowercases and strips punctuation to single spaces", () => {
    expect(normalizeText("Reset my password!!")).toBe("reset my password");
    expect(normalizeText("  hey,   there. ")).toBe("hey there");
  });

  it("keeps unicode letters and digits", () => {
    expect(normalizeText("Café №5 ümlaut")).toBe("café 5 ümlaut");
  });

  it("maps empty and punctuation-only input to the empty string", () => {
    expect(normalizeText("")).toBe("");
    expect(normalizeText("?!... ---")).toBe("");
  });
});

describe("wordVector", () => {
  it("is l2-normalized", () => {
    expect(norm(wordVector("reset my password"))).toBeCloseTo(1, 10);
  });

  it("returns an empty vector for empty input", () => {
    expect(wordVector("").size).toBe(0);
    expect(wordVector("!!!").size).toBe(0);
  });

  it("scores identical text 1 and disjoint text 0", () => {
    expect(cosine(wordVector("roll back my deploy"), wordVector("Roll back my deploy."))).toBeCloseTo(1, 10);
    expect(cosine(wordVector("alpha beta"), wordVector("gamma delta"))).toBe(0);
  });

  it("matches a hand-computed cosine", () => {
    // "a b" -> {w:a, w:b, b:a b}, "a c" -> {w:a, w:c, b:a c}; dot = 1/3
    expect(cosine(wordVector("a b"), wordVector("a c"))).toBeCloseTo(1 / 3, 10);
  });

  it("penalizes word order through bigrams", () => {
    // shared unigrams a and b, bigrams differ: dot = 2/3
    expect(cosine(wordVector("alpha beta"), wordVector("beta alpha"))).toBeCloseTo(2 / 3, 10);
  });

  it("is deterministic", () => {
    expect(wordVector("raise my rate limit")).toEqual(wordVector("raise my rate limit"));
  });
});

describe("charVector", () => {
  it("builds boundary-marked trigrams and normalizes", () => {
    const vector = charVector("abc");
    // " abc " -> " ab", "abc", "bc "
    expect(vector.size).toBe(3);
    expect(norm(vector)).toBeCloseTo(1, 10);
  });

  it("returns an empty vector for empty input", () => {
    expect(charVector("").size).toBe(0);
  });

  it("survives a typo that zeroes word similarity", () => {
    const wordSim = cosine(wordVector("password"), wordVector("passwrod"));
    const charSim = cosine(charVector("password"), charVector("passwrod"));
    expect(wordSim).toBe(0);
    expect(charSim).toBeGreaterThan(0.3);
  });

  it("handles unicode input", () => {
    expect(norm(charVector("café crème"))).toBeCloseTo(1, 10);
  });
});

describe("cosine", () => {
  it("is symmetric", () => {
    const a = wordVector("export my account data");
    const b = wordVector("delete my account data");
    expect(cosine(a, b)).toBeCloseTo(cosine(b, a), 12);
    expect(cosine(a, b)).toBeGreaterThan(0);
    expect(cosine(a, b)).toBeLessThan(1);
  });

  it("is 0 against an empty vector", () => {
    expect(cosine(wordVector(""), wordVector("anything"))).toBe(0);
  });
});
