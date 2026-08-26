import { describe, expect, it } from "vitest";
import { createRng } from "../../05-token-streaming/src/rng.js";
import {
  decorrelatedJitter,
  exponential,
  exponentialEqualJitter,
  exponentialFullJitter,
  fixedDelay,
  immediate,
  retryAfterExact,
  retryAfterJitter,
  type PolicyContext,
} from "../src/policies.js";

function ctx(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return { attempt: 1, prevDelaySec: 0, retryAfterSec: 1, rng: createRng(42), ...overrides };
}

describe("basic policies", () => {
  it("immediate always returns 0", () => {
    const p = immediate();
    expect(p.nextDelaySec(ctx({ attempt: 1 }))).toBe(0);
    expect(p.nextDelaySec(ctx({ attempt: 9 }))).toBe(0);
  });

  it("fixedDelay always returns its delay", () => {
    const p = fixedDelay(2.5);
    expect(p.nextDelaySec(ctx({ attempt: 1 }))).toBe(2.5);
    expect(p.nextDelaySec(ctx({ attempt: 7 }))).toBe(2.5);
  });
});

describe("exponential", () => {
  it("doubles from base and clamps at cap", () => {
    const p = exponential(1, 30);
    const delays = [1, 2, 3, 4, 5, 6, 7].map((attempt) => p.nextDelaySec(ctx({ attempt })));
    expect(delays).toEqual([1, 2, 4, 8, 16, 30, 30]);
  });

  it("does not overflow to Infinity at absurd attempt counts", () => {
    const p = exponential(1, 30);
    expect(p.nextDelaySec(ctx({ attempt: 10_000 }))).toBe(30);
  });
});

describe("jitter variants", () => {
  it("full jitter stays within [0, expo backoff] and actually varies", () => {
    const p = exponentialFullJitter(1, 30);
    const rng = createRng(7);
    const draws = Array.from({ length: 200 }, () => p.nextDelaySec(ctx({ attempt: 4, rng })));
    for (const d of draws) {
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(8);
    }
    expect(new Set(draws.map((d) => d.toFixed(6))).size).toBeGreaterThan(100);
  });

  it("equal jitter stays within [half, full] of the expo backoff", () => {
    const p = exponentialEqualJitter(1, 30);
    const rng = createRng(8);
    for (let i = 0; i < 200; i++) {
      const d = p.nextDelaySec(ctx({ attempt: 4, rng }));
      expect(d).toBeGreaterThanOrEqual(4);
      expect(d).toBeLessThanOrEqual(8);
    }
  });

  it("decorrelated jitter draws from [base, 3 * prev], capped", () => {
    const p = decorrelatedJitter(1, 30);
    const rng = createRng(9);
    // First retry: prevDelaySec is 0, so prev falls back to base.
    for (let i = 0; i < 100; i++) {
      const d = p.nextDelaySec(ctx({ attempt: 1, prevDelaySec: 0, rng }));
      expect(d).toBeGreaterThanOrEqual(1);
      expect(d).toBeLessThanOrEqual(3);
    }
    for (let i = 0; i < 100; i++) {
      const d = p.nextDelaySec(ctx({ attempt: 5, prevDelaySec: 20, rng }));
      expect(d).toBeGreaterThanOrEqual(1);
      expect(d).toBeLessThanOrEqual(30); // cap binds below 3 * 20
    }
  });

  it("is deterministic for the same seed", () => {
    const p = exponentialFullJitter(1, 30);
    const a = createRng(123);
    const b = createRng(123);
    const seqA = Array.from({ length: 50 }, (_, i) =>
      p.nextDelaySec(ctx({ attempt: (i % 9) + 1, rng: a })),
    );
    const seqB = Array.from({ length: 50 }, (_, i) =>
      p.nextDelaySec(ctx({ attempt: (i % 9) + 1, rng: b })),
    );
    expect(seqA).toEqual(seqB);
  });
});

describe("retry-after policies", () => {
  it("exact returns the server hint verbatim, including Infinity", () => {
    const p = retryAfterExact();
    expect(p.nextDelaySec(ctx({ retryAfterSec: 4 }))).toBe(4);
    expect(p.nextDelaySec(ctx({ retryAfterSec: Number.POSITIVE_INFINITY }))).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it("jittered stays within [hint, hint + expo backoff]", () => {
    const p = retryAfterJitter(1, 30);
    const rng = createRng(10);
    for (let i = 0; i < 200; i++) {
      const d = p.nextDelaySec(ctx({ attempt: 3, retryAfterSec: 5, rng }));
      expect(d).toBeGreaterThanOrEqual(5);
      expect(d).toBeLessThanOrEqual(9);
    }
  });
});
