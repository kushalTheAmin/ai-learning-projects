import { describe, expect, it } from "vitest";
import {
  crossover,
  makeFlakyItems,
  runFlakyStudy,
  spreadFlakyIds,
} from "../src/flaky-study.js";
import type { FlakyRow, FlakyStudyConfig } from "../src/flaky-study.js";

function cfg(overrides: Partial<FlakyStudyConfig>): FlakyStudyConfig {
  return {
    seed: 42,
    batchSize: 8,
    trials: 40,
    maxRetries: 3,
    flakyCounts: [1],
    flakeRates: [0.5],
    ...overrides,
  };
}

describe("spreadFlakyIds", () => {
  it("centers a single flaky item and spaces several evenly", () => {
    expect(spreadFlakyIds(32, 1)).toEqual([16]);
    expect(spreadFlakyIds(32, 4)).toEqual([4, 12, 20, 28]);
    expect(spreadFlakyIds(8, 8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(spreadFlakyIds(32, 0)).toEqual([]);
  });

  it("never collides ids for any count up to the batch size", () => {
    for (let count = 1; count <= 32; count++) {
      const ids = spreadFlakyIds(32, count);
      expect(new Set(ids).size).toBe(count);
      expect(ids.every((id) => id >= 0 && id < 32)).toBe(true);
    }
  });

  it("rejects counts outside the batch", () => {
    expect(() => spreadFlakyIds(8, 9)).toThrow(/cannot place/);
    expect(() => spreadFlakyIds(8, -1)).toThrow(/cannot place/);
  });
});

describe("makeFlakyItems", () => {
  it("marks exactly the requested ids flaky at the requested rate", () => {
    const items = makeFlakyItems(6, [1, 4], 0.3);
    expect(items).toHaveLength(6);
    expect(items.filter((i) => (i.flakeRate ?? 0) > 0).map((i) => i.id)).toEqual([1, 4]);
    expect(items[1]!.flakeRate).toBe(0.3);
    expect(items.every((i) => !i.poisoned)).toBe(true);
  });

  it("rejects rates outside [0, 1]", () => {
    expect(() => makeFlakyItems(4, [0], 1.1)).toThrow(/flakeRate/);
    expect(() => makeFlakyItems(4, [0], -0.1)).toThrow(/flakeRate/);
    expect(() => makeFlakyItems(4, [0], Number.NaN)).toThrow(/flakeRate/);
  });
});

describe("runFlakyStudy", () => {
  it("is a pure function of its config", async () => {
    const config = cfg({ trials: 20 });
    const first = await runFlakyStudy(config);
    const second = await runFlakyStudy(config);
    expect(second).toEqual(first);
  });

  it("degenerates to one clean call per trial at rate 0", async () => {
    const rows = await runFlakyStudy(cfg({ flakeRates: [0], trials: 10 }));
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.firstCallFailedPct).toBe(0);
      expect(row.meanCalls).toBe(1);
      expect(row.healthyCompletedPct).toBe(100);
      expect(row.flakyCompletedPct).toBe(100);
    }
  });

  it("pins exact deterministic costs at rate 1", async () => {
    const rows = await runFlakyStudy(cfg({ flakeRates: [1], trials: 10, maxRetries: 3 }));
    const byStrategy = new Map(rows.map((r) => [r.strategy, r]));
    for (const row of rows) {
      expect(row.firstCallFailedPct).toBe(100);
      expect(row.flakyCompletedPct).toBe(0);
    }
    // batch 8, flaky id 4, budget 4:
    // one-by-one: 1 whole + 7 healthy singles + 4 attempts on the bad one.
    expect(byStrategy.get("one-by-one")!.meanCalls).toBe(12);
    // bisect: [0..7] fail, [0..3] pass, [4..7] fail, [4,5] fail,
    // [4] four failing attempts, [5] pass, [6,7] pass.
    expect(byStrategy.get("bisect")!.meanCalls).toBe(10);
    expect(byStrategy.get("retry-whole")!.meanCalls).toBe(4);
    expect(byStrategy.get("fail-all")!.meanCalls).toBe(1);
    expect(byStrategy.get("one-by-one")!.healthyCompletedPct).toBe(100);
    expect(byStrategy.get("bisect")!.healthyCompletedPct).toBe(100);
    expect(byStrategy.get("retry-whole")!.healthyCompletedPct).toBe(0);
  });

  it("agrees on the first-call failure rate across strategies", async () => {
    const rows = await runFlakyStudy(cfg({ trials: 50 }));
    const rates = new Set(rows.map((r) => r.firstCallFailedPct));
    expect(rates.size).toBe(1);
    const rate = [...rates][0]!;
    expect(rate).toBeGreaterThan(20);
    expect(rate).toBeLessThan(80);
  });

  it("keeps retry-whole all-or-nothing: healthy and flaky completion move together", async () => {
    const rows = await runFlakyStudy(cfg({ trials: 60 }));
    const retryWhole = rows.find((r) => r.strategy === "retry-whole")!;
    expect(retryWhole.healthyCompletedPct).toBeCloseTo(retryWhole.flakyCompletedPct, 10);
    const failAll = rows.find((r) => r.strategy === "fail-all")!;
    expect(failAll.firstCallFailedPct + failAll.healthyCompletedPct).toBeCloseTo(100, 10);
  });

  it("matches the analytic completion odds for a lone rate-0.5 flaky item", async () => {
    // one-by-one gives the flaky item one whole-batch ride plus 4 singleton
    // attempts: completion odds 1 - 0.5^5 = 96.9%. 200 trials should land
    // in a wide band around that.
    const rows = await runFlakyStudy(cfg({ trials: 200 }));
    const oneByOne = rows.find((r) => r.strategy === "one-by-one")!;
    expect(oneByOne.healthyCompletedPct).toBe(100);
    expect(oneByOne.flakyCompletedPct).toBeGreaterThan(88);
    const bisect = rows.find((r) => r.strategy === "bisect")!;
    expect(bisect.healthyCompletedPct).toBe(100);
    // At one low-rate flaky item, bisect must still undercut one-by-one.
    expect(bisect.meanCalls).toBeLessThan(oneByOne.meanCalls);
  });
});

describe("crossover", () => {
  it("computes bisect over one-by-one ratios per config", () => {
    const row = (strategy: FlakyRow["strategy"], meanCalls: number, meanInputTokens: number): FlakyRow => ({
      flakyCount: 1,
      flakeRate: 0.3,
      strategy,
      firstCallFailedPct: 50,
      meanCalls,
      meanInputTokens,
      healthyCompletedPct: 100,
      flakyCompletedPct: 90,
      meanElapsedMs: 500,
    });
    const ratios = crossover([
      row("one-by-one", 10, 4000),
      row("bisect", 5, 5000),
      row("fail-all", 1, 640),
    ]);
    expect(ratios).toEqual([
      { flakyCount: 1, flakeRate: 0.3, callsRatio: 0.5, tokensRatio: 1.25 },
    ]);
  });

  it("skips configs missing either side of the comparison", () => {
    expect(crossover([])).toEqual([]);
  });
});
