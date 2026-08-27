import { describe, expect, it } from "vitest";
import { PrefixCache, type Block, type CacheConfig } from "../src/cache.js";

/** 400 chars = exactly 100 tokens under the 4-chars-per-token estimate. */
const block = (fill: string): Block => ({ text: fill.repeat(400 / fill.length) });

const SMALL: CacheConfig = { minCacheableTokens: 50, maxBreakpoints: 4, lookbackBlocks: 20 };
const TTL = 300_000;

describe("PrefixCache billing", () => {
  it("bills everything uncached with no breakpoints", () => {
    const cache = new PrefixCache(SMALL);
    const usage = cache.process({ blocks: [block("a"), block("b")], breakpoints: [], ttlMs: TTL }, 0);
    expect(usage).toEqual({
      uncachedTokens: 200,
      readTokens: 0,
      writeTokens: 0,
      writeTtlMs: TTL,
      hitBlockIndex: -1,
    });
  });

  it("writes the whole prefix on a cold miss and reads it back on an exact repeat", () => {
    const cache = new PrefixCache(SMALL);
    const request = { blocks: [block("a"), block("b"), block("c")], breakpoints: [2], ttlMs: TTL };
    const first = cache.process(request, 0);
    expect(first).toMatchObject({ uncachedTokens: 0, readTokens: 0, writeTokens: 300, hitBlockIndex: -1 });
    const second = cache.process(request, 1_000);
    expect(second).toMatchObject({ uncachedTokens: 0, readTokens: 300, writeTokens: 0, hitBlockIndex: 2 });
  });

  it("bills only the delta past the longest hit when the conversation grows", () => {
    const cache = new PrefixCache(SMALL);
    const history = [block("a"), block("b"), block("c")];
    cache.process({ blocks: history, breakpoints: [2], ttlMs: TTL }, 0);
    const grown = [...history, block("d"), block("e")];
    const usage = cache.process({ blocks: grown, breakpoints: [2, 4], ttlMs: TTL }, 1_000);
    expect(usage).toMatchObject({ readTokens: 300, writeTokens: 200, uncachedTokens: 0, hitBlockIndex: 2 });
  });

  it("leaves blocks past the last breakpoint uncached", () => {
    const cache = new PrefixCache(SMALL);
    const usage = cache.process(
      { blocks: [block("a"), block("b"), block("c")], breakpoints: [1], ttlMs: TTL },
      0,
    );
    expect(usage).toMatchObject({ writeTokens: 200, uncachedTokens: 100 });
  });

  it("prefers the longest cached prefix over a shorter one", () => {
    const cache = new PrefixCache(SMALL);
    const blocks = [block("a"), block("b"), block("c"), block("d")];
    cache.process({ blocks, breakpoints: [1, 3], ttlMs: TTL }, 0);
    const usage = cache.process({ blocks: [...blocks, block("e")], breakpoints: [4], ttlMs: TTL }, 1_000);
    expect(usage).toMatchObject({ readTokens: 400, writeTokens: 100, hitBlockIndex: 3 });
  });

  it("misses when the head of the prefix changes, even with an identical tail", () => {
    const cache = new PrefixCache(SMALL);
    const tail = [block("b"), block("c")];
    cache.process({ blocks: [block("a"), ...tail], breakpoints: [2], ttlMs: TTL }, 0);
    const usage = cache.process({ blocks: [block("x"), ...tail], breakpoints: [2], ttlMs: TTL }, 1_000);
    expect(usage).toMatchObject({ readTokens: 0, writeTokens: 300, hitBlockIndex: -1 });
  });

  it("keeps block boundaries unambiguous for equal concatenations", () => {
    const cache = new PrefixCache({ ...SMALL, minCacheableTokens: 1 });
    cache.process({ blocks: [{ text: "ab" }, { text: "c" }], breakpoints: [1], ttlMs: TTL }, 0);
    const usage = cache.process({ blocks: [{ text: "a" }, { text: "bc" }], breakpoints: [1], ttlMs: TTL }, 1_000);
    expect(usage.hitBlockIndex).toBe(-1);
  });

  it("handles unicode content and repeated identical blocks", () => {
    const cache = new PrefixCache({ ...SMALL, minCacheableTokens: 1 });
    const blocks = [{ text: "こんにちは世界 🌍 émoji" }, { text: "こんにちは世界 🌍 émoji" }];
    const first = cache.process({ blocks, breakpoints: [1], ttlMs: TTL }, 0);
    expect(first.hitBlockIndex).toBe(-1);
    const second = cache.process({ blocks, breakpoints: [1], ttlMs: TTL }, 1_000);
    expect(second.hitBlockIndex).toBe(1);
    expect(second.readTokens).toBe(first.writeTokens);
  });

  it("handles an empty request", () => {
    const cache = new PrefixCache(SMALL);
    const usage = cache.process({ blocks: [], breakpoints: [], ttlMs: TTL }, 0);
    expect(usage).toMatchObject({ uncachedTokens: 0, readTokens: 0, writeTokens: 0, hitBlockIndex: -1 });
  });

  it("caches a single-block request", () => {
    const cache = new PrefixCache(SMALL);
    cache.process({ blocks: [block("a")], breakpoints: [0], ttlMs: TTL }, 0);
    const usage = cache.process({ blocks: [block("a")], breakpoints: [0], ttlMs: TTL }, 1);
    expect(usage).toMatchObject({ readTokens: 100, writeTokens: 0 });
  });
});

describe("PrefixCache ttl", () => {
  it("expires an entry exactly at the ttl boundary", () => {
    const cache = new PrefixCache(SMALL);
    const request = { blocks: [block("a")], breakpoints: [0], ttlMs: TTL };
    cache.process(request, 0);
    expect(cache.process(request, TTL - 1).hitBlockIndex).toBe(0);
    const cold = new PrefixCache(SMALL);
    cold.process(request, 0);
    expect(cold.process(request, TTL).hitBlockIndex).toBe(-1);
  });

  it("refreshes the timer on every read, for free", () => {
    const cache = new PrefixCache(SMALL);
    const request = { blocks: [block("a")], breakpoints: [0], ttlMs: TTL };
    cache.process(request, 0);
    const read = cache.process(request, TTL - 100_000);
    expect(read).toMatchObject({ readTokens: 100, writeTokens: 0 });
    // alive because the read at TTL-100s pushed expiry to 2*TTL-100s
    expect(cache.process(request, 2 * TTL - 100_001).hitBlockIndex).toBe(0);
  });

  it("refreshes with the entry's own ttl, not the reading request's", () => {
    const cache = new PrefixCache(SMALL);
    const blocks = [block("a")];
    cache.process({ blocks, breakpoints: [0], ttlMs: TTL }, 0);
    cache.process({ blocks, breakpoints: [0], ttlMs: 100 * TTL }, 1_000); // read refreshes to 1000 + TTL
    expect(cache.process({ blocks, breakpoints: [0], ttlMs: TTL }, 1_000 + TTL).hitBlockIndex).toBe(-1);
  });

  it("counts expired entries in stats", () => {
    const cache = new PrefixCache(SMALL);
    const request = { blocks: [block("a")], breakpoints: [0], ttlMs: TTL };
    cache.process(request, 0);
    cache.process(request, 2 * TTL);
    expect(cache.snapshotStats().entriesExpired).toBe(1);
    expect(cache.liveEntryCount(2 * TTL)).toBe(1); // rewritten by the second request
  });
});

describe("PrefixCache limits", () => {
  it("silently skips prefixes below the minimum cacheable length", () => {
    const cache = new PrefixCache({ ...SMALL, minCacheableTokens: 150 });
    const request = { blocks: [block("a")], breakpoints: [0], ttlMs: TTL };
    const first = cache.process(request, 0);
    expect(first).toMatchObject({ uncachedTokens: 100, writeTokens: 0 });
    // nothing was cached, so the repeat still misses
    expect(cache.process(request, 1).hitBlockIndex).toBe(-1);
  });

  it("still writes a later breakpoint when an earlier one is below the minimum", () => {
    const cache = new PrefixCache({ ...SMALL, minCacheableTokens: 150 });
    const usage = cache.process({ blocks: [block("a"), block("b")], breakpoints: [0, 1], ttlMs: TTL }, 0);
    expect(usage).toMatchObject({ writeTokens: 200, uncachedTokens: 0 });
  });

  it("rejects more than four distinct breakpoints but dedupes repeats", () => {
    const cache = new PrefixCache(SMALL);
    const blocks = [block("a"), block("b"), block("c"), block("d"), block("e")];
    expect(() => cache.process({ blocks, breakpoints: [0, 1, 2, 3, 4], ttlMs: TTL }, 0)).toThrow(/exceed/);
    expect(() => cache.process({ blocks, breakpoints: [0, 1, 2, 3, 3], ttlMs: TTL }, 0)).not.toThrow();
  });

  it("rejects breakpoints outside the request", () => {
    const cache = new PrefixCache(SMALL);
    expect(() => cache.process({ blocks: [block("a")], breakpoints: [1], ttlMs: TTL }, 0)).toThrow(/outside/);
    expect(() => cache.process({ blocks: [], breakpoints: [0], ttlMs: TTL }, 0)).toThrow(/outside/);
    expect(() => cache.process({ blocks: [block("a")], breakpoints: [0.5], ttlMs: TTL }, 0)).toThrow(/outside/);
  });

  it("finds an entry 19 blocks behind a breakpoint but not 20", () => {
    const pad = (n: number): Block[] => Array.from({ length: n }, (_, i) => ({ text: `pad ${i} `.repeat(10) }));
    for (const [distance, hit] of [
      [19, true],
      [20, false],
    ] as const) {
      const cache = new PrefixCache({ ...SMALL, minCacheableTokens: 1 });
      const base = pad(5);
      cache.process({ blocks: base, breakpoints: [4], ttlMs: TTL }, 0);
      const grown = [...base, ...pad(40).slice(5, 5 + distance)];
      const usage = cache.process({ blocks: grown, breakpoints: [grown.length - 1], ttlMs: TTL }, 1_000);
      expect(usage.hitBlockIndex).toBe(hit ? 4 : -1);
    }
  });
});
