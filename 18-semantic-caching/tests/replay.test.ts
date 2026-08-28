import { describe, expect, it } from "vitest";
import { INTENTS } from "../src/dataset.js";
import { FEATURIZERS } from "../src/features.js";
import { noCacheCost, runReplay } from "../src/replay.js";
import { DEFAULT_TRAFFIC, generateTraffic, type TrafficRequest } from "../src/traffic.js";

const word = FEATURIZERS[0]!;

function request(text: string, intentId: string): TrafficRequest {
  return { text, intentId, phrasingClass: "canonical", typoed: false };
}

const TRAFFIC = generateTraffic(DEFAULT_TRAFFIC);

describe("runReplay", () => {
  it("with the semantic layer disabled, never serves a wrong answer", () => {
    const result = runReplay(TRAFFIC, word, Number.POSITIVE_INFINITY, "exact-only");
    expect(result.semanticCorrect).toBe(0);
    expect(result.semanticWrong).toBe(0);
    expect(result.wrongPer1k).toBe(0);
    expect(result.llmCalls + result.exactHits).toBe(TRAFFIC.length);
  });

  it("accounts for every request exactly once", () => {
    const result = runReplay(TRAFFIC, word, 0.7, "word");
    const total = result.llmCalls + result.exactHits + result.semanticCorrect + result.semanticWrong;
    expect(total).toBe(TRAFFIC.length);
  });

  it("at threshold 0 only the first request reaches the model", () => {
    const result = runReplay(TRAFFIC.slice(0, 200), word, 0, "word");
    expect(result.llmCalls).toBe(1);
  });

  it("charges nothing for hits and everything for misses", () => {
    const result = runReplay(TRAFFIC, word, 0.7, "word");
    const baseline = noCacheCost(TRAFFIC);
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.costUsd).toBeLessThan(baseline);
    expect(result.savedVsNoCache).toBeGreaterThan(0);
    expect(result.savedVsNoCache).toBeLessThan(1);
  });

  it("counts a near-miss serve as a wrong answer", () => {
    const traffic = [request("reset my password", "reset-password"), request("reset my api key", "reset-api-key")];
    const result = runReplay(traffic, word, 0.4, "word");
    expect(result.llmCalls).toBe(1);
    expect(result.semanticWrong).toBe(1);
    expect(result.wrongPer1k).toBe(500);
  });

  it("counts a same-intent serve as correct", () => {
    const traffic = [
      request("reset my password", "reset-password"),
      request("hey reset my password please", "reset-password"),
    ];
    const result = runReplay(traffic, word, 0.5, "word");
    expect(result.llmCalls).toBe(1);
    expect(result.semanticCorrect).toBe(1);
    expect(result.semanticWrong).toBe(0);
  });

  it("is deterministic", () => {
    const a = runReplay(TRAFFIC, word, 0.75, "word");
    const b = runReplay(TRAFFIC, word, 0.75, "word");
    expect(a).toEqual(b);
  });

  it("handles empty traffic without dividing by zero", () => {
    const result = runReplay([], word, 0.7, "word");
    expect(result.requests).toBe(0);
    expect(result.wrongPer1k).toBe(0);
    expect(result.savedVsNoCache).toBe(0);
    expect(Number.isNaN(result.costUsd)).toBe(false);
  });
});

describe("full-replay facts the readme quotes", () => {
  it("word at 0.80 serves zero wrong answers; word at 0.50 serves many", () => {
    const strict = runReplay(TRAFFIC, word, 0.8, "word");
    const loose = runReplay(TRAFFIC, word, 0.5, "word");
    expect(strict.semanticWrong).toBe(0);
    expect(loose.semanticWrong).toBeGreaterThan(50);
    expect(loose.savedVsNoCache).toBeGreaterThan(strict.savedVsNoCache);
  });

  it("every configuration beats no cache and the semantic layer beats exact-only", () => {
    const exactOnly = runReplay(TRAFFIC, word, Number.POSITIVE_INFINITY, "exact-only");
    const semantic = runReplay(TRAFFIC, word, 0.8, "word");
    expect(exactOnly.savedVsNoCache).toBeGreaterThan(0.3);
    expect(semantic.savedVsNoCache).toBeGreaterThan(exactOnly.savedVsNoCache);
  });

  it("char catches more typoed requests semantically than word at 0.75", () => {
    const char = FEATURIZERS[1]!;
    const wordResult = runReplay(TRAFFIC, word, 0.75, "word");
    const charResult = runReplay(TRAFFIC, char, 0.75, "char");
    expect(charResult.semanticHitsOnTypoed).toBeGreaterThan(wordResult.semanticHitsOnTypoed);
  });
});
