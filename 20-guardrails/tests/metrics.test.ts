import { describe, expect, it } from "vitest";
import { finalize, perTypeCounts, rocAuc, scorePiiSpans, sweepThresholds } from "../src/metrics.js";
import type { PiiSpan } from "../src/pii.js";

function span(start: number, end: number, type: PiiSpan["type"], value = "x"): PiiSpan {
  return { start, end, type, value };
}

describe("scorePiiSpans", () => {
  it("counts a true positive only on exact start/end/type match", () => {
    const gold = [span(0, 5, "EMAIL")];
    expect(scorePiiSpans(gold, [span(0, 5, "EMAIL")]).tp).toBe(1);
    expect(scorePiiSpans(gold, [span(0, 5, "PHONE")]).tp).toBe(0);
    expect(scorePiiSpans(gold, [span(0, 4, "EMAIL")]).tp).toBe(0);
  });

  it("charges unmatched predictions as fp and unmatched gold as fn", () => {
    const s = scorePiiSpans([span(0, 5, "EMAIL"), span(6, 9, "IP")], [span(0, 5, "EMAIL"), span(20, 24, "CARD")]);
    expect(s).toMatchObject({ tp: 1, fp: 1, fn: 1 });
  });

  it("is perfect precision and recall on an exact match set", () => {
    const both = [span(0, 5, "EMAIL"), span(6, 9, "IP")];
    const s = scorePiiSpans(both, both);
    expect(s.precision).toBe(1);
    expect(s.recall).toBe(1);
    expect(s.f1).toBe(1);
  });
});

describe("perTypeCounts", () => {
  it("splits tp/fp/fn by type", () => {
    const gold = [span(0, 5, "EMAIL"), span(6, 9, "IP")];
    const pred = [span(0, 5, "EMAIL"), span(10, 14, "EMAIL")];
    const counts = perTypeCounts(gold, pred);
    expect(counts.get("EMAIL")).toMatchObject({ tp: 1, fp: 1, fn: 0 });
    expect(counts.get("IP")).toMatchObject({ tp: 0, fp: 0, fn: 1 });
  });
});

describe("rocAuc", () => {
  it("is 1.0 for perfectly separated scores", () => {
    expect(rocAuc([3, 4, 5], [0, 1, 2])).toBe(1);
  });

  it("is 0.5 for identical distributions", () => {
    expect(rocAuc([1, 2], [1, 2])).toBe(0.5);
  });

  it("gives half credit for ties", () => {
    expect(rocAuc([1], [1])).toBe(0.5);
    expect(rocAuc([2, 1], [1, 0])).toBeCloseTo(0.875, 10);
  });
});

describe("sweepThresholds", () => {
  it("produces monotone recall as the threshold falls", () => {
    const points = sweepThresholds([3, 5], [0, 1]);
    const recalls = points.map((p) => p.recall);
    for (let i = 1; i < recalls.length; i++) {
      expect(recalls[i - 1]!).toBeGreaterThanOrEqual(recalls[i]!);
    }
  });
});

describe("finalize edge cases", () => {
  it("defines precision and recall as 1 when there is nothing to find or predict", () => {
    expect(finalize({ tp: 0, fp: 0, fn: 0 })).toMatchObject({ precision: 1, recall: 1, f1: 1 });
  });
});
