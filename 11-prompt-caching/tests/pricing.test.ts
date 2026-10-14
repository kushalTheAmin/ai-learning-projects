import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRICING,
  TTL_1H_MS,
  TTL_5M_MS,
  inputCost,
  requestCost,
  writeMultiplier,
  type BilledUsage,
} from "../src/pricing.js";

const zero: BilledUsage = {
  uncachedTokens: 0,
  readTokens: 0,
  writeTokens: 0,
  writeTtlMs: TTL_5M_MS,
  outputTokens: 0,
};

describe("requestCost", () => {
  it("bills uncached input at the base price", () => {
    expect(requestCost({ ...zero, uncachedTokens: 1_000_000 })).toBeCloseTo(3, 10);
  });

  it("bills cache reads at 0.1x", () => {
    expect(requestCost({ ...zero, readTokens: 1_000_000 })).toBeCloseTo(0.3, 10);
  });

  it("bills 5m cache writes at 1.25x", () => {
    expect(requestCost({ ...zero, writeTokens: 1_000_000 })).toBeCloseTo(3.75, 10);
  });

  it("bills 1h cache writes at 2x", () => {
    expect(requestCost({ ...zero, writeTokens: 1_000_000, writeTtlMs: TTL_1H_MS })).toBeCloseTo(6, 10);
  });

  it("bills output at the output price", () => {
    expect(requestCost({ ...zero, outputTokens: 1_000_000 })).toBeCloseTo(15, 10);
  });

  it("sums the components", () => {
    const usage: BilledUsage = {
      uncachedTokens: 500_000,
      readTokens: 2_000_000,
      writeTokens: 100_000,
      writeTtlMs: TTL_5M_MS,
      outputTokens: 50_000,
    };
    // 0.5 * 3 + 2 * 0.3 + 0.1 * 3.75 + 0.05 * 15
    expect(requestCost(usage)).toBeCloseTo(1.5 + 0.6 + 0.375 + 0.75, 10);
    expect(inputCost(usage)).toBeCloseTo(1.5 + 0.6 + 0.375, 10);
  });

  it("costs nothing for zero usage", () => {
    expect(requestCost(zero)).toBe(0);
  });

  it("throws on an unconfigured ttl only when writes exist", () => {
    expect(() => writeMultiplier(DEFAULT_PRICING, 1234)).toThrow(/no write multiplier/);
    expect(() => requestCost({ ...zero, writeTtlMs: 1234 })).not.toThrow();
    expect(() => requestCost({ ...zero, writeTokens: 1, writeTtlMs: 1234 })).toThrow(/no write multiplier/);
  });
});
