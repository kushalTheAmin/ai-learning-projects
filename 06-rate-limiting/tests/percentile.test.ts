import { describe, expect, it } from "vitest";
import { percentile } from "../src/percentile.js";

describe("percentile", () => {
  it("matches the interpolation behavior of 02's python implementation", () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([10, 20, 30, 40, 50], 0.25)).toBe(20);
    expect(percentile([10, 20], 0.75)).toBe(17.5);
  });

  it("returns the endpoints at q=0 and q=1", () => {
    expect(percentile([3, 7, 9], 0)).toBe(3);
    expect(percentile([3, 7, 9], 1)).toBe(9);
  });

  it("handles a single element for any q", () => {
    expect(percentile([42], 0.99)).toBe(42);
  });

  it("throws on empty input and out-of-range q", () => {
    expect(() => percentile([], 0.5)).toThrow(/empty/);
    expect(() => percentile([1], -0.1)).toThrow(/q must be/);
    expect(() => percentile([1], 1.1)).toThrow(/q must be/);
    expect(() => percentile([1], Number.NaN)).toThrow(/q must be/);
  });
});
