import { describe, expect, it } from "vitest";
import { cappedExponential, nextDelayMs, type BackoffPolicy } from "../src/backoff.js";
import { createRng } from "../../05-token-streaming/src/rng.js";

const BASE = 100;
const CAP = 10_000;

describe("cappedExponential", () => {
  it("doubles per attempt and stops at the cap", () => {
    expect(cappedExponential(BASE, CAP, 1)).toBe(100);
    expect(cappedExponential(BASE, CAP, 2)).toBe(200);
    expect(cappedExponential(BASE, CAP, 3)).toBe(400);
    expect(cappedExponential(BASE, CAP, 7)).toBe(6400);
    expect(cappedExponential(BASE, CAP, 8)).toBe(CAP);
  });

  it("stays finite at absurd attempt counts", () => {
    expect(cappedExponential(BASE, CAP, 1000)).toBe(CAP);
    expect(cappedExponential(BASE, CAP, Number.MAX_SAFE_INTEGER)).toBe(CAP);
  });
});

describe("nextDelayMs", () => {
  it("rejects attempt numbers below 1", () => {
    const rng = createRng(1);
    const policy: BackoffPolicy = { kind: "fixed", delayMs: 50 };
    expect(() => nextDelayMs(policy, 0, undefined, rng)).toThrow(/positive integer/);
    expect(() => nextDelayMs(policy, 1.5, undefined, rng)).toThrow(/positive integer/);
  });

  it("fixed ignores attempt and rng", () => {
    const rng = createRng(1);
    const policy: BackoffPolicy = { kind: "fixed", delayMs: 250 };
    expect(nextDelayMs(policy, 1, undefined, rng)).toBe(250);
    expect(nextDelayMs(policy, 9, undefined, rng)).toBe(250);
  });

  it("full jitter draws inside [0, exp)", () => {
    const rng = createRng(7);
    const policy: BackoffPolicy = { kind: "full-jitter", baseMs: BASE, capMs: CAP };
    for (let attempt = 1; attempt <= 8; attempt++) {
      const exp = cappedExponential(BASE, CAP, attempt);
      for (let i = 0; i < 200; i++) {
        const d = nextDelayMs(policy, attempt, undefined, rng);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThan(exp);
      }
    }
  });

  it("equal jitter draws inside [exp/2, exp)", () => {
    const rng = createRng(7);
    const policy: BackoffPolicy = { kind: "equal-jitter", baseMs: BASE, capMs: CAP };
    for (let attempt = 1; attempt <= 8; attempt++) {
      const exp = cappedExponential(BASE, CAP, attempt);
      for (let i = 0; i < 200; i++) {
        const d = nextDelayMs(policy, attempt, undefined, rng);
        expect(d).toBeGreaterThanOrEqual(exp / 2);
        expect(d).toBeLessThan(exp);
      }
    }
  });

  it("decorrelated jitter draws inside [base, prev*3) and respects the cap", () => {
    const rng = createRng(11);
    const policy: BackoffPolicy = { kind: "decorrelated-jitter", baseMs: BASE, capMs: CAP };
    let prev: number | undefined;
    for (let attempt = 1; attempt <= 50; attempt++) {
      const hi = Math.max(BASE, (prev ?? BASE) * 3);
      const d = nextDelayMs(policy, attempt, prev, rng);
      expect(d).toBeGreaterThanOrEqual(BASE);
      expect(d).toBeLessThanOrEqual(Math.min(CAP, hi));
      prev = d;
    }
  });

  it("is deterministic for a given seed", () => {
    const policy: BackoffPolicy = { kind: "full-jitter", baseMs: BASE, capMs: CAP };
    const a = createRng(99);
    const b = createRng(99);
    for (let attempt = 1; attempt <= 20; attempt++) {
      expect(nextDelayMs(policy, attempt, undefined, a)).toBe(
        nextDelayMs(policy, attempt, undefined, b),
      );
    }
  });
});
