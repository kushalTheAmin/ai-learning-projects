import { describe, expect, it } from "vitest";
import { TTL_5M_MS } from "../src/pricing.js";
import { incremental, none, staticOnly } from "../src/strategies.js";
import {
  DEFAULT_SEED,
  agentWorkload,
  replay,
  runLookback,
  runOneShot,
  runStrategyComparison,
  runTtlSweep,
  runVolatileHeader,
} from "../src/experiment.js";

describe("replay", () => {
  it("conserves prospective input tokens across strategies", () => {
    const events = agentWorkload(1, 2, 4, 10_000);
    const prospective = (s: typeof none): number => {
      const t = replay(events, s, TTL_5M_MS);
      return t.uncachedTokens + t.readTokens + t.writeTokens;
    };
    const baseline = prospective(none);
    expect(baseline).toBeGreaterThan(0);
    expect(prospective(staticOnly)).toBe(baseline);
    expect(prospective(incremental)).toBe(baseline);
  });

  it("is deterministic end to end", () => {
    expect(runStrategyComparison()).toEqual(runStrategyComparison());
  });
});

describe("strategy comparison", () => {
  const rows = runStrategyComparison();
  const byName = Object.fromEntries(rows.map((r) => [r.strategy, r]));

  it("orders costs none > static-only > incremental", () => {
    expect(byName["static-only"]!.totals.inputCost).toBeLessThan(byName["none"]!.totals.inputCost);
    expect(byName["incremental"]!.totals.inputCost).toBeLessThan(byName["static-only"]!.totals.inputCost);
  });

  it("gives the no-caching baseline zero hits and zero savings", () => {
    expect(byName["none"]!.totals.hitRate).toBe(0);
    expect(byName["none"]!.totals.requestsWithHit).toBe(0);
    expect(byName["none"]!.savingsVsNone).toBe(0);
  });

  it("shows the healthy incremental signature: writes stay near the per-turn delta", () => {
    const totals = byName["incremental"]!.totals;
    expect(totals.uncachedTokens).toBe(0);
    // every request except the six cold conversation starts must hit
    expect(totals.requestsWithHit).toBeGreaterThanOrEqual(totals.requests - 6);
    // total writes stay a small fraction of what a full-rewrite loop would bill
    expect(totals.writeTokens).toBeLessThan(0.2 * totals.readTokens);
  });
});

describe("volatile header", () => {
  const rows = runVolatileHeader();
  const volatileRow = rows.find((r) => r.variant === "volatile header")!;
  const stableRow = rows.find((r) => r.variant === "stable header")!;

  it("kills every cache hit", () => {
    expect(volatileRow.totals.requestsWithHit).toBe(0);
    expect(volatileRow.totals.hitRate).toBe(0);
  });

  it("costs more than not caching at all: every token pays the write premium", () => {
    // zero reads and zero uncached tokens, so the ratio is the write
    // multiplier itself and nothing else
    expect(volatileRow.totals.readTokens).toBe(0);
    expect(volatileRow.totals.uncachedTokens).toBe(0);
    expect(volatileRow.costRatioVsNone).toBeCloseTo(1.25, 10);
    expect(stableRow.costRatioVsNone).toBeLessThan(0.3);
  });

  it("prices each variant against its own workload's no-caching baseline", () => {
    // the volatile header adds tokens to every request, so the two variants
    // are different traffic and cannot share a denominator
    for (const [row, volatile_] of [
      [stableRow, false],
      [volatileRow, true],
    ] as const) {
      const events = agentWorkload(DEFAULT_SEED, 6, 10, 30_000, volatile_);
      const ownBaseline = replay(events, none, TTL_5M_MS).inputCost;
      expect(row.costRatioVsNone).toBeCloseTo(row.totals.inputCost / ownBaseline, 12);
    }
    const stableTokens = replay(agentWorkload(DEFAULT_SEED, 6, 10, 30_000, false), none, TTL_5M_MS);
    const volatileTokens = replay(agentWorkload(DEFAULT_SEED, 6, 10, 30_000, true), none, TTL_5M_MS);
    expect(volatileTokens.uncachedTokens).toBeGreaterThan(stableTokens.uncachedTokens);
  });
});

describe("one-shot workload", () => {
  it("bills exactly the 1.25x write premium for zero reads", () => {
    const rows = runOneShot();
    const cached = rows.find((r) => r.variant === "caching on")!;
    expect(cached.totals.readTokens).toBe(0);
    expect(cached.totals.uncachedTokens).toBe(0);
    expect(cached.costRatioVsNone).toBeCloseTo(1.25, 10);
  });
});

describe("ttl sweep", () => {
  const rows = runTtlSweep();
  const row = (gapMin: number, ttl: string) =>
    rows.find((r) => r.gapMs === gapMin * 60_000 && r.ttlLabel === ttl)!;

  it("prefers the 5m ttl under continuous traffic", () => {
    expect(row(1, "5m").totals.inputCost).toBeLessThan(row(1, "1h").totals.inputCost);
    expect(row(4, "5m").totals.requestsWithHit).toBe(11);
  });

  it("turns the 5m cache into a pure loss once gaps pass the ttl", () => {
    for (const gapMin of [8, 25]) {
      expect(row(gapMin, "5m").totals.requestsWithHit).toBe(0);
      expect(row(gapMin, "5m").costRatioVsNone).toBeCloseTo(1.25, 10);
      expect(row(gapMin, "1h").totals.inputCost).toBeLessThan(row(gapMin, "5m").totals.inputCost);
    }
  });

  it("loses on both ttls once gaps pass an hour", () => {
    expect(row(70, "5m").costRatioVsNone).toBeCloseTo(1.25, 10);
    expect(row(70, "1h").costRatioVsNone).toBeCloseTo(2, 10);
  });
});

describe("20-block lookback", () => {
  const rows = runLookback();
  const row = (blocks: number, strategy: string) =>
    rows.find((r) => r.blocksPerTurn === blocks && r.strategy === strategy)!;

  it("does not separate the strategies while turns fit the window", () => {
    expect(row(10, "incremental").totals.inputCost).toBeCloseTo(row(10, "spaced-15").totals.inputCost, 10);
  });

  it("silently degrades the tail breakpoint once a turn appends more than 20 blocks", () => {
    const broken = row(26, "incremental");
    const spaced = row(26, "spaced-15");
    expect(broken.totals.hitRate).toBeLessThan(0.3);
    expect(spaced.totals.hitRate).toBeGreaterThan(0.6);
    expect(spaced.totals.inputCost).toBeLessThan(0.5 * broken.totals.inputCost);
    // the broken variant rewrites the whole history every turn and ends up
    // costing more than not caching at all
    expect(broken.costRatioVsNone).toBeGreaterThan(1);
  });
});
