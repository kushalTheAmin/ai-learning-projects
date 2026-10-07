import { describe, expect, it } from "vitest";
import { DEFAULT_CACHE_CONFIG, PrefixCache, type Block, type CacheConfig } from "../src/cache.js";
import { agentWorkload, replay, runLookback, DEFAULT_SEED } from "../src/experiment.js";
import { incremental, none } from "../src/strategies.js";
import { TTL_5M_MS } from "../src/pricing.js";

const TTL = 300_000;
const SMALL: CacheConfig = { minCacheableTokens: 1, maxBreakpoints: 4, lookbackBlocks: 20 };
const pad = (count: number, offset = 0): Block[] =>
  Array.from({ length: count }, (_, i) => ({ text: `pad ${i + offset} `.repeat(10) }));

/**
 * The lookback window is `lookbackBlocks` blocks behind the breakpoint. The
 * modelled rule is that the provider checks the ~20 content-block boundaries
 * preceding each explicit breakpoint, so an entry sitting exactly
 * `lookbackBlocks` blocks behind one is still reachable and the block after
 * that is not.
 */
describe("lookback window reach", () => {
  const reaches = (lookbackBlocks: number, distance: number): boolean => {
    const cache = new PrefixCache({ ...SMALL, lookbackBlocks });
    const base = pad(5);
    cache.process({ blocks: base, breakpoints: [4], ttlMs: TTL }, 0);
    const grown = [...base, ...pad(distance, 100)];
    const usage = cache.process({ blocks: grown, breakpoints: [grown.length - 1], ttlMs: TTL }, 1_000);
    return usage.hitBlockIndex === 4;
  };

  it("reaches an entry exactly lookbackBlocks behind the breakpoint", () => {
    expect(reaches(20, 20)).toBe(true);
  });

  it("does not reach one block past the window", () => {
    expect(reaches(20, 21)).toBe(false);
  });

  it("scales the reach with the configured window, off no magic number", () => {
    for (const lookbackBlocks of [1, 2, 5, 13, 20, 37]) {
      expect(reaches(lookbackBlocks, lookbackBlocks)).toBe(true);
      expect(reaches(lookbackBlocks, lookbackBlocks + 1)).toBe(false);
    }
  });

  it("still finds the breakpoint's own prefix on an exact repeat at any window", () => {
    for (const lookbackBlocks of [0, 1, 20]) {
      expect(reaches(lookbackBlocks, 0)).toBe(true);
    }
  });
});

/**
 * Experiment 5's threshold, stated end to end: the tail breakpoint of turn n
 * sits exactly blocksPerTurn blocks behind the entry turn n-1 wrote, so the
 * naive strategy survives a turn appending the whole window and only
 * collapses once a turn appends more than it.
 */
describe("the blocks-per-turn threshold the lookback sets", () => {
  const naive = (blocksPerTurn: number) => {
    const events = agentWorkload(DEFAULT_SEED + 11, 1, 8, 30_000, false, blocksPerTurn - 2);
    const baseline = replay(events, none, TTL_5M_MS).inputCost;
    const totals = replay(events, incremental, TTL_5M_MS);
    return { hitRate: totals.hitRate, ratio: totals.inputCost / baseline };
  };

  it("survives a turn appending exactly the lookback window", () => {
    expect(DEFAULT_CACHE_CONFIG.lookbackBlocks).toBe(20);
    const row = naive(20);
    expect(row.hitRate).toBeGreaterThan(0.6);
    expect(row.ratio).toBeLessThan(1);
  });

  it("collapses on the first turn that appends more than the window", () => {
    const row = naive(21);
    expect(row.hitRate).toBeLessThan(0.3);
    expect(row.ratio).toBeGreaterThan(1);
  });

  it("puts the collapse exactly one block past the window, not inside it", () => {
    for (const blocksPerTurn of [17, 18, 19, 20]) {
      expect(naive(blocksPerTurn).ratio).toBeLessThan(1);
    }
    for (const blocksPerTurn of [21, 22, 26]) {
      expect(naive(blocksPerTurn).ratio).toBeGreaterThan(1);
    }
  });
});

/** The published experiment-5 rows sit either side of the window, so nothing moves. */
describe("published lookback rows", () => {
  const rows = runLookback();
  const row = (blocks: number, strategy: string) =>
    rows.find((r) => r.blocksPerTurn === blocks && r.strategy === strategy)!;

  it("keeps the 10-blocks-per-turn rows identical and cheap", () => {
    for (const strategy of ["incremental", "spaced-15"]) {
      expect(row(10, strategy).costRatioVsNone).toBeCloseTo(0.34, 2);
      expect(row(10, strategy).totals.hitRate).toBeCloseTo(0.791, 3);
    }
  });

  it("keeps the 26-blocks-per-turn split identical", () => {
    expect(row(26, "incremental").costRatioVsNone).toBeCloseTo(1.072, 3);
    expect(row(26, "incremental").totals.hitRate).toBeCloseTo(0.155, 3);
    expect(row(26, "spaced-15").costRatioVsNone).toBeCloseTo(0.362, 3);
    expect(row(26, "spaced-15").totals.hitRate).toBeCloseTo(0.772, 3);
  });
});
