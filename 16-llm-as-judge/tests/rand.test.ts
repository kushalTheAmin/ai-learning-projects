import { describe, expect, test } from "vitest";
import { fnv1a, gaussian, streamFor, uniform } from "../src/rand.js";

describe("fnv1a", () => {
  test("is deterministic and matches the reference value for an empty string", () => {
    expect(fnv1a("")).toBe(0x811c9dc5);
    expect(fnv1a("judge|pair|core-001|a")).toBe(fnv1a("judge|pair|core-001|a"));
  });

  test("distinct identities hash apart", () => {
    expect(fnv1a("a|pair|x|a")).not.toBe(fnv1a("a|pair|x|b"));
    expect(fnv1a("calibrated|point|g1")).not.toBe(fnv1a("primacy|point|g1"));
  });

  test("handles unicode identities", () => {
    expect(fnv1a("naïve|判定")).toBe(fnv1a("naïve|判定"));
    expect(fnv1a("naïve|判定")).not.toBe(fnv1a("naive|判定"));
  });
});

describe("streamFor", () => {
  test("same identity replays the same stream", () => {
    const a = streamFor("id-1");
    const b = streamFor("id-1");
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  test("different identities give different streams", () => {
    expect(streamFor("id-1")()).not.toBe(streamFor("id-2")());
  });
});

describe("gaussian", () => {
  test("is deterministic for a fixed stream", () => {
    expect(gaussian(streamFor("g"))).toBe(gaussian(streamFor("g")));
  });

  test("sample mean and std land near 0 and 1", () => {
    const rng = streamFor("gaussian-moments");
    const n = 20000;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const x = gaussian(rng);
      sum += x;
      sumSq += x * x;
    }
    const mean = sum / n;
    const std = Math.sqrt(sumSq / n - mean * mean);
    expect(Math.abs(mean)).toBeLessThan(0.03);
    expect(Math.abs(std - 1)).toBeLessThan(0.03);
  });

  test("stays finite even when the raw draw is 0", () => {
    const zeroFirst = (() => {
      let calls = 0;
      return () => (calls++ === 0 ? 0 : 0.25);
    })();
    expect(Number.isFinite(gaussian(zeroFirst))).toBe(true);
  });
});

describe("uniform", () => {
  test("respects bounds", () => {
    const rng = streamFor("uniform");
    for (let i = 0; i < 1000; i++) {
      const x = uniform(rng, 0.15, 0.55);
      expect(x).toBeGreaterThanOrEqual(0.15);
      expect(x).toBeLessThan(0.55);
    }
  });
});
