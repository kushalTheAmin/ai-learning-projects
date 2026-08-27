/**
 * Simulated provider-side prompt cache. Models the documented semantics:
 * the cache key is an exact prefix of the rendered request, a hit is the
 * longest previously cached prefix of the current request, writes bill only
 * the delta past that hit, entries expire on a TTL that every read or write
 * refreshes for free, prefixes below a minimum token count silently do not
 * cache, at most 4 breakpoints per request, and each breakpoint only looks
 * back 20 content blocks for a prior entry.
 *
 * Keys are the exact prefix text (length-prefixed per block, so block
 * boundaries are unambiguous). A real cache hashes; exact keys have the same
 * hit/miss behavior with zero collision risk at this scale.
 */

import { estimateTokens } from "../../08-agent-tool-loop/src/messages.js";

export interface Block {
  text: string;
}

export interface CacheRequest {
  /** Rendered request in order: tools, system, then message blocks. */
  blocks: readonly Block[];
  /** Indices of blocks carrying a cache breakpoint; prefix = blocks[0..=i]. */
  breakpoints: readonly number[];
  /** TTL applied to entries this request writes. */
  ttlMs: number;
}

export interface CacheUsage {
  uncachedTokens: number;
  readTokens: number;
  writeTokens: number;
  writeTtlMs: number;
  /** Block index of the longest cache hit, -1 on a full miss. */
  hitBlockIndex: number;
}

export interface CacheConfig {
  minCacheableTokens: number;
  maxBreakpoints: number;
  lookbackBlocks: number;
}

/** Sonnet-class defaults: 1024-token minimum cacheable prefix. */
export const DEFAULT_CACHE_CONFIG: CacheConfig = {
  minCacheableTokens: 1024,
  maxBreakpoints: 4,
  lookbackBlocks: 20,
};

interface Entry {
  expiresAtMs: number;
  ttlMs: number;
}

export interface CacheStats {
  requests: number;
  requestsWithHit: number;
  entriesWritten: number;
  entriesExpired: number;
}

export class PrefixCache {
  private readonly entries = new Map<string, Entry>();
  private readonly stats: CacheStats = {
    requests: 0,
    requestsWithHit: 0,
    entriesWritten: 0,
    entriesExpired: 0,
  };

  constructor(private readonly config: CacheConfig = DEFAULT_CACHE_CONFIG) {}

  /** Bill one request against the cache at time `nowMs` and update entries. */
  process(request: CacheRequest, nowMs: number): CacheUsage {
    const { blocks, ttlMs } = request;
    const breakpoints = normalizeBreakpoints(request.breakpoints, blocks.length, this.config.maxBreakpoints);
    this.stats.requests++;

    // Cumulative token count of the prefix ending at each block (exclusive
    // sentinel at index 0 so cum[i + 1] = tokens of blocks[0..=i]).
    const cum: number[] = [0];
    for (const block of blocks) {
      cum.push(cum[cum.length - 1]! + estimateTokens(block.text));
    }
    const totalTokens = cum[blocks.length]!;

    // Longest unexpired entry reachable from any breakpoint's lookback window.
    let hit = -1;
    for (const bp of breakpoints) {
      for (let q = bp; q > bp - this.config.lookbackBlocks && q >= 0 && q > hit; q--) {
        const entry = this.entries.get(prefixKey(blocks, q));
        if (!entry) continue;
        if (entry.expiresAtMs <= nowMs) {
          this.entries.delete(prefixKey(blocks, q));
          this.stats.entriesExpired++;
          continue;
        }
        hit = q;
        break;
      }
    }
    if (hit >= 0) {
      this.stats.requestsWithHit++;
      const key = prefixKey(blocks, hit);
      const entry = this.entries.get(key)!;
      entry.expiresAtMs = nowMs + entry.ttlMs; // reads refresh for free
    }

    // Write an entry at every breakpoint past the hit whose full prefix is
    // long enough to cache; billing covers the delta from hit to the
    // furthest written breakpoint.
    let maxWritten = -1;
    for (const bp of breakpoints) {
      if (bp <= hit) continue;
      if (cum[bp + 1]! < this.config.minCacheableTokens) continue;
      this.entries.set(prefixKey(blocks, bp), { expiresAtMs: nowMs + ttlMs, ttlMs });
      this.stats.entriesWritten++;
      maxWritten = Math.max(maxWritten, bp);
    }

    const readTokens = hit >= 0 ? cum[hit + 1]! : 0;
    const writeTokens = maxWritten >= 0 ? cum[maxWritten + 1]! - readTokens : 0;
    return {
      uncachedTokens: totalTokens - readTokens - writeTokens,
      readTokens,
      writeTokens,
      writeTtlMs: ttlMs,
      hitBlockIndex: hit,
    };
  }

  snapshotStats(): CacheStats {
    return { ...this.stats };
  }

  liveEntryCount(nowMs: number): number {
    let live = 0;
    for (const entry of this.entries.values()) {
      if (entry.expiresAtMs > nowMs) live++;
    }
    return live;
  }
}

function normalizeBreakpoints(breakpoints: readonly number[], blockCount: number, max: number): number[] {
  const unique = [...new Set(breakpoints)].sort((a, b) => a - b);
  if (unique.length > max) {
    throw new Error(`${unique.length} cache breakpoints exceed the maximum of ${max}`);
  }
  for (const bp of unique) {
    if (!Number.isInteger(bp) || bp < 0 || bp >= blockCount) {
      throw new Error(`breakpoint ${bp} is outside the request's ${blockCount} blocks`);
    }
  }
  return unique;
}

function prefixKey(blocks: readonly Block[], endIndex: number): string {
  const parts: string[] = [];
  for (let i = 0; i <= endIndex; i++) {
    const text = blocks[i]!.text;
    parts.push(`${text.length}:${text}`);
  }
  return parts.join("|");
}
