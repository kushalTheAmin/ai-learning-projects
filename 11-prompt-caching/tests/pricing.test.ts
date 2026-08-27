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
    expect(requestCost({ ...zero, uncachedTokens: 1_000_000 })).toBeCloseTo(2, 10);
  });

  it("bills cache reads at 0.1x", () => {
    expect(requestCost({ ...zero, readTokens: 1_000_000 })).toBeCloseTo(0.2, 10);
  });

  it("bills 5m cache writes at 1.25x", () => {
    expect(requestCost({ ...zero, writeTokens: 1_000_000 })).toBeCloseTo(2.5, 10);
  });

  it("bills 1h cache writes at 2x", () => {
    expect(requestCost({ ...zero, writeTokens: 1_000_000, writeTtlMs: TTL_1H_MS })).toBeCloseTo(4, 10);
  });

  it("bills output at the output price", () => {
    expect(requestCost({ ...zero, outputTokens: 1_000_000 })).toBeCloseTo(10, 10);
  });

  it("sums the components", () => {
    const usage: BilledUsage = {
      uncachedTokens: 500_000,
      readTokens: 2_000_000,
      writeTokens: 100_000,
      writeTtlMs: TTL_5M_MS,
      outputTokens: 50_000,
    };
    // 0.5 * 2 + 2 * 0.2 + 0.1 * 2.5 + 0.05 * 10
    expect(requestCost(usage)).toBeCloseTo(1 + 0.4 + 0.25 + 0.5, 10);
    expect(inputCost(usage)).toBeCloseTo(1 + 0.4 + 0.25, 10);
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
