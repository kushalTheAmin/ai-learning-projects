import { describe, expect, it } from "vitest";
import { DEFAULT_CACHE_CONFIG, type CacheConfig } from "../src/cache.js";
import { TTL_5M_MS } from "../src/pricing.js";
import { incremental, none } from "../src/strategies.js";
import { replay, type ReplayEvent } from "../src/experiment.js";
import { makeConversation, renderConversation, type RenderedRequest } from "../src/workload.js";
import {
  addVolatileBlock,
  runVolatilePosition,
  SWEEP_POSITIONS,
  TAIL_POSITION,
  VOLATILE_BLOCK_CHARS,
  volatileAware,
  type VolatileRenderedRequest,
} from "../src/volatile-study.js";

function renderBase(turnCount = 4): RenderedRequest[] {
  return renderConversation(makeConversation(7, turnCount, 2));
}

function toEvents(requests: readonly VolatileRenderedRequest[], gapMs = 1000): ReplayEvent<VolatileRenderedRequest>[] {
  return requests.map((request, i) => ({ request, arrivalMs: i * gapMs }));
}

/** Tiny config so short test conversations actually cache. */
const OPEN_CONFIG: CacheConfig = { ...DEFAULT_CACHE_CONFIG, minCacheableTokens: 1 };

describe("addVolatileBlock", () => {
  it("inserts one block at the requested index and shifts the rest right", () => {
    const base = renderBase();
    const last = base[base.length - 1]!;
    const withVolatile = addVolatileBlock(base, 2);
    const lastVolatile = withVolatile[withVolatile.length - 1]!;
    expect(lastVolatile.blocks).toHaveLength(last.blocks.length + 1);
    expect(lastVolatile.volatileIndex).toBe(2);
    expect(lastVolatile.blocks[2]!.text.startsWith("state snapshot")).toBe(true);
    const withoutInserted = lastVolatile.blocks.filter((_, i) => i !== 2);
    expect(withoutInserted).toEqual(last.blocks);
  });

  it("clamps the index to just before the final user message on short requests", () => {
    const base = renderBase(3);
    const withVolatile = addVolatileBlock(base, 100);
    for (let i = 0; i < base.length; i++) {
      const request = withVolatile[i]!;
      expect(request.volatileIndex).toBe(base[i]!.blocks.length - 1);
      expect(request.blocks[request.blocks.length - 1]!.text).toBe(
        base[i]!.blocks[base[i]!.blocks.length - 1]!.text,
      );
    }
  });

  it("treats TAIL_POSITION as always just before the user message", () => {
    const base = renderBase(3);
    const withVolatile = addVolatileBlock(base, TAIL_POSITION);
    for (let i = 0; i < base.length; i++) {
      expect(withVolatile[i]!.volatileIndex).toBe(base[i]!.blocks.length - 1);
    }
  });

  it("gives every request a distinct volatile text of constant length", () => {
    const withVolatile = addVolatileBlock(renderBase(4), 2);
    const texts = withVolatile.map((request) => request.blocks[request.volatileIndex]!.text);
    expect(new Set(texts).size).toBe(texts.length);
    for (const text of texts) expect(text).toHaveLength(VOLATILE_BLOCK_CHARS);
  });

  it("salts the volatile text so conversations never collide", () => {
    const base = renderBase(2);
    const a = addVolatileBlock(base, 2, 1)[0]!.blocks[2]!.text;
    const b = addVolatileBlock(base, 2, 2)[0]!.blocks[2]!.text;
    expect(a).not.toBe(b);
  });

  it("shifts staticPrefixEnd only when the block lands at or before it", () => {
    const base = renderBase(3);
    expect(addVolatileBlock(base, 0)[2]!.staticPrefixEnd).toBe(2);
    expect(addVolatileBlock(base, 1)[2]!.staticPrefixEnd).toBe(2);
    expect(addVolatileBlock(base, 2)[2]!.staticPrefixEnd).toBe(1);
    expect(addVolatileBlock(base, TAIL_POSITION)[2]!.staticPrefixEnd).toBe(1);
  });

  it("keeps the pre-volatile prefix stable across consecutive requests", () => {
    const withVolatile = addVolatileBlock(renderBase(5), 6);
    for (let i = 1; i < withVolatile.length; i++) {
      const prev = withVolatile[i - 1]!;
      const curr = withVolatile[i]!;
      const shared = Math.min(prev.volatileIndex, curr.volatileIndex);
      for (let b = 0; b < shared; b++) {
        expect(curr.blocks[b]!.text).toBe(prev.blocks[b]!.text);
      }
    }
  });

  it("rejects negative and fractional positions", () => {
    const base = renderBase(1);
    expect(() => addVolatileBlock(base, -1)).toThrow(/non-negative integer/);
    expect(() => addVolatileBlock(base, 1.5)).toThrow(/non-negative integer/);
  });

  it("returns an empty list for an empty conversation", () => {
    expect(addVolatileBlock([], 3)).toEqual([]);
  });

  it("leaves unicode block content untouched", () => {
    const request: RenderedRequest = {
      blocks: [{ text: "café \u{1f680} naïve" }, { text: "你好 question" }],
      staticPrefixEnd: 0,
      outputTokens: 10,
    };
    const withVolatile = addVolatileBlock([request], 1);
    expect(withVolatile[0]!.blocks[0]!.text).toBe("café \u{1f680} naïve");
    expect(withVolatile[0]!.blocks[2]!.text).toBe("你好 question");
  });
});

describe("volatileAware", () => {
  const aware = (volatileIndex: number, staticPrefixEnd: number): number[] =>
    volatileAware({
      blocks: [],
      staticPrefixEnd,
      outputTokens: 0,
      volatileIndex,
    });

  it("marks nothing when the volatile block leads the request", () => {
    expect(aware(0, 2)).toEqual([]);
  });

  it("marks only the tools block when the volatile block sits inside the static prefix", () => {
    expect(aware(1, 2)).toEqual([0]);
  });

  it("collapses to one breakpoint when the block sits right after the static prefix", () => {
    expect(aware(2, 1)).toEqual([1]);
  });

  it("marks the static prefix and the deepest stable block for deep positions", () => {
    expect(aware(10, 1)).toEqual([1, 9]);
  });

  it("never marks at or past the volatile block", () => {
    for (const volatileIndex of [0, 1, 2, 5, 20]) {
      for (const point of aware(volatileIndex, 1)) {
        expect(point).toBeLessThan(volatileIndex);
      }
    }
  });
});

describe("cache semantics under a volatile block", () => {
  it("prefixes before the volatile block hit, prefixes containing it never do", () => {
    const requests = addVolatileBlock(renderBase(4), 2);
    const events = toEvents(requests);
    const withAware = replay(events, volatileAware, TTL_5M_MS, undefined, OPEN_CONFIG);
    // Every request after the first hits the entry written at block 1.
    expect(withAware.requestsWithHit).toBe(requests.length - 1);
    // Oblivious incremental writes through the volatile block every turn;
    // its tail entries are never read back, so hits also cap at the static
    // prefix and the write bill dwarfs the aware one.
    const withIncremental = replay(events, incremental, TTL_5M_MS, undefined, OPEN_CONFIG);
    expect(withIncremental.requestsWithHit).toBe(requests.length - 1);
    expect(withIncremental.readTokens).toBe(withAware.readTokens);
    expect(withIncremental.writeTokens).toBeGreaterThan(withAware.writeTokens * 3);
  });

  it("a leading volatile block kills every hit for the oblivious strategy", () => {
    const requests = addVolatileBlock(renderBase(4), 0);
    const totals = replay(toEvents(requests), incremental, TTL_5M_MS, undefined, OPEN_CONFIG);
    expect(totals.requestsWithHit).toBe(0);
    expect(totals.readTokens).toBe(0);
    expect(totals.uncachedTokens).toBe(0);
    expect(totals.writeTokens).toBeGreaterThan(0);
  });

  it("under the default config the lone tools breakpoint is below the cacheable floor", () => {
    const requests = addVolatileBlock(renderBase(4), 1);
    const totals = replay(toEvents(requests), volatileAware, TTL_5M_MS);
    expect(totals.readTokens).toBe(0);
    expect(totals.writeTokens).toBe(0);
    expect(totals.requestsWithHit).toBe(0);
  });
});

describe("runVolatilePosition", () => {
  const rows = runVolatilePosition();
  const awareRows = rows.filter((row) => row.strategy === "aware");
  const incrementalRows = rows.filter(
    (row) => row.strategy === "incremental" && row.positionLabel !== "stable",
  );
  const stableRow = rows[rows.length - 1]!;

  it("emits two rows per swept position plus the stable control", () => {
    expect(rows).toHaveLength(SWEEP_POSITIONS.length * 2 + 1);
    expect(stableRow.positionLabel).toBe("stable");
    expect(stableRow.finalIndex).toBe(-1);
  });

  it("bills identical prospective tokens at every position", () => {
    const prospective = (row: (typeof rows)[number]): number =>
      row.totals.uncachedTokens + row.totals.readTokens + row.totals.writeTokens;
    const expected = prospective(rows[0]!);
    for (const row of rows) {
      if (row.positionLabel === "stable") continue;
      expect(prospective(row)).toBe(expected);
    }
  });

  it("charges the oblivious strategy the pure write multiplier when the block leads", () => {
    for (const label of ["0", "1"]) {
      const row = incrementalRows.find((r) => r.positionLabel === label)!;
      expect(row.costRatioVsNone).toBeCloseTo(1.25, 3);
      expect(row.totals.requestsWithHit).toBe(0);
    }
  });

  it("prices the aware strategy exactly at baseline when nothing stable exists", () => {
    const row = awareRows.find((r) => r.positionLabel === "0")!;
    expect(row.costRatioVsNone).toBeCloseTo(1, 6);
    expect(row.totals.readTokens).toBe(0);
    expect(row.totals.writeTokens).toBe(0);
  });

  it("keeps the oblivious cost flat across every position past the static prefix", () => {
    const past = incrementalRows.filter((row) => !["0", "1"].includes(row.positionLabel));
    const first = past[0]!.totals.inputCost;
    for (const row of past) {
      expect(row.totals.inputCost).toBeCloseTo(first, 10);
    }
  });

  it("drops the aware cost monotonically as the volatile block moves deeper", () => {
    for (let i = 1; i < awareRows.length; i++) {
      expect(awareRows[i]!.costRatioVsNone).toBeLessThanOrEqual(
        awareRows[i - 1]!.costRatioVsNone + 1e-12,
      );
    }
    expect(awareRows[awareRows.length - 1]!.costRatioVsNone).toBeLessThan(0.35);
  });

  it("beats the oblivious strategy at every position with a stable prefix to save", () => {
    for (const awareRow of awareRows) {
      if (["0", "1"].includes(awareRow.positionLabel)) continue;
      const twin = incrementalRows.find((r) => r.positionLabel === awareRow.positionLabel)!;
      expect(awareRow.costRatioVsNone).toBeLessThan(twin.costRatioVsNone);
    }
  });

  it("never beats the stable conversation", () => {
    for (const row of awareRows) {
      expect(row.costRatioVsNone).toBeGreaterThan(stableRow.costRatioVsNone);
    }
  });

  it("is deterministic", () => {
    expect(runVolatilePosition()).toEqual(rows);
  });

  it("replays the baseline as pure uncached spend", () => {
    const requests = addVolatileBlock(renderBase(3), 2);
    const totals = replay(toEvents(requests), none, TTL_5M_MS);
    expect(totals.readTokens).toBe(0);
    expect(totals.writeTokens).toBe(0);
    expect(totals.uncachedTokens).toBeGreaterThan(0);
  });
});
