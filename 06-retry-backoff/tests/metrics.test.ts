import { describe, expect, it } from "vitest";
import { percentile } from "../src/metrics.js";

describe("percentile (linear interpolation)", () => {
  it("matches known values on a small list", () => {
    const values = [1, 2, 3, 4];
    expect(percentile(values, 0)).toBe(1);
    expect(percentile(values, 1)).toBe(4);
    expect(percentile(values, 0.5)).toBe(2.5);
    expect(percentile(values, 0.25)).toBeCloseTo(1.75);
  });

  it("handles a single element", () => {
    expect(percentile([7], 0)).toBe(7);
    expect(percentile([7], 0.5)).toBe(7);
    expect(percentile([7], 1)).toBe(7);
  });

  it("does not mutate its input and does not require sorted input", () => {
    const values = [3, 1, 2];
    expect(percentile(values, 0.5)).toBe(2);
    expect(values).toEqual([3, 1, 2]);
  });

  it("handles duplicate values", () => {
    expect(percentile([5, 5, 5, 5], 0.95)).toBe(5);
  });

  it("throws on empty input and out-of-range q", () => {
    expect(() => percentile([], 0.5)).toThrow(RangeError);
    expect(() => percentile([1], -0.1)).toThrow(RangeError);
    expect(() => percentile([1], 1.1)).toThrow(RangeError);
  });
});
