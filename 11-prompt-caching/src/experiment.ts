/**
 * The measured experiments. Each replays a seeded workload through the
 * simulated cache under one or more breakpoint strategies and reports what
 * the accounting model says the traffic would bill.
 */

import { DEFAULT_CACHE_CONFIG, PrefixCache, type CacheConfig } from "./cache.js";
import { DEFAULT_PRICING, TTL_1H_MS, TTL_5M_MS, inputCost, type Pricing } from "./pricing.js";
import { STRATEGIES, incremental, none, spacedForLookback } from "./strategies.js";
import {
  exponentialArrivals,
  makeConversation,
  makeOneShotRequests,
  renderConversation,
  type RenderedRequest,
} from "./workload.js";
import { createRng } from "../../05-token-streaming/src/rng.js";

export const DEFAULT_SEED = 20260827;

export interface ReplayEvent<R extends RenderedRequest = RenderedRequest> {
  request: R;
  arrivalMs: number;
}

export interface ReplayTotals {
  requests: number;
  uncachedTokens: number;
  readTokens: number;
  writeTokens: number;
  outputTokens: number;
  inputCost: number;
  /** Fraction of prospective input tokens served from cache. */
  hitRate: number;
  requestsWithHit: number;
  writeTokensPerRequest: number[];
}

export function replay<R extends RenderedRequest = RenderedRequest>(
  events: readonly ReplayEvent<R>[],
  strategy: (request: R) => number[],
  ttlMs: number,
  pricing: Pricing = DEFAULT_PRICING,
  cacheConfig: CacheConfig = DEFAULT_CACHE_CONFIG,
): ReplayTotals {
  const cache = new PrefixCache(cacheConfig);
  const totals: ReplayTotals = {
    requests: 0,
    uncachedTokens: 0,
    readTokens: 0,
    writeTokens: 0,
    outputTokens: 0,
    inputCost: 0,
    hitRate: 0,
    requestsWithHit: 0,
    writeTokensPerRequest: [],
  };
  for (const event of events) {
    const usage = cache.process(
      { blocks: event.request.blocks, breakpoints: strategy(event.request), ttlMs },
      event.arrivalMs,
    );
    totals.requests++;
    totals.uncachedTokens += usage.uncachedTokens;
    totals.readTokens += usage.readTokens;
    totals.writeTokens += usage.writeTokens;
    totals.outputTokens += event.request.outputTokens;
    totals.inputCost += inputCost({ ...usage, outputTokens: 0 }, pricing);
    if (usage.hitBlockIndex >= 0) totals.requestsWithHit++;
    totals.writeTokensPerRequest.push(usage.writeTokens);
  }
  const prospective = totals.uncachedTokens + totals.readTokens + totals.writeTokens;
  totals.hitRate = prospective === 0 ? 0 : totals.readTokens / prospective;
  return totals;
}

/** Interleave several conversations into one time-ordered event stream. */
export function agentWorkload(
  seed: number,
  conversations: number,
  turnsPerConversation: number,
  meanTurnGapMs: number,
  volatileHeader = false,
  toolBlocksPerTurn = 0,
): ReplayEvent[] {
  const events: ReplayEvent[] = [];
  for (let c = 0; c < conversations; c++) {
    const turns = makeConversation(seed + 17 * c, turnsPerConversation, toolBlocksPerTurn);
    const requests = renderConversation(turns, { volatileHeader, headerSalt: c });
    const rng = createRng(seed + 1000 + c);
    const arrivals = exponentialArrivals(rng, requests.length, meanTurnGapMs, c * 5_000);
    for (let i = 0; i < requests.length; i++) {
      events.push({ request: requests[i]!, arrivalMs: arrivals[i]! });
    }
  }
  return events.sort((a, b) => a.arrivalMs - b.arrivalMs);
}

// ---------------------------------------------------------------------------
// experiment 1: breakpoint strategy on a multi-conversation agent workload

export interface StrategyRow {
  strategy: string;
  totals: ReplayTotals;
  savingsVsNone: number;
}

export function runStrategyComparison(seed = DEFAULT_SEED): StrategyRow[] {
  const events = agentWorkload(seed, 6, 10, 30_000);
  const names = ["none", "static-only", "incremental"] as const;
  const rows: StrategyRow[] = names.map((name) => ({
    strategy: name,
    totals: replay(events, STRATEGIES[name]!, TTL_5M_MS),
    savingsVsNone: 0,
  }));
  const baseline = rows[0]!.totals.inputCost;
  for (const row of rows) {
    row.savingsVsNone = 1 - row.totals.inputCost / baseline;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// experiment 2: a volatile header at the top of the system prompt

export interface VolatileRow {
  variant: string;
  totals: ReplayTotals;
  costRatioVsNone: number;
}

export function runVolatileHeader(seed = DEFAULT_SEED): VolatileRow[] {
  // The header adds tokens to every request, so the two variants are
  // different traffic: each is priced against its own no-caching baseline.
  const variants = [
    { variant: "stable header", volatileHeader: false },
    { variant: "volatile header", volatileHeader: true },
  ];
  return variants.map(({ variant, volatileHeader }) => {
    const events = agentWorkload(seed, 6, 10, 30_000, volatileHeader);
    const baseline = replay(events, none, TTL_5M_MS).inputCost;
    const totals = replay(events, incremental, TTL_5M_MS);
    return { variant, totals, costRatioVsNone: totals.inputCost / baseline };
  });
}

// ---------------------------------------------------------------------------
// experiment 3: one-shot requests with caching left on

export interface OneShotRow {
  variant: string;
  totals: ReplayTotals;
  costRatioVsNone: number;
}

export function runOneShot(seed = DEFAULT_SEED): OneShotRow[] {
  const requests = makeOneShotRequests(seed + 3, 40, 6_000);
  const rng = createRng(seed + 4);
  const arrivals = exponentialArrivals(rng, requests.length, 15_000);
  const events = requests.map((request, i) => ({ request, arrivalMs: arrivals[i]! }));
  const baseline = replay(events, none, TTL_5M_MS);
  const cached = replay(events, incremental, TTL_5M_MS);
  return [
    { variant: "no caching", totals: baseline, costRatioVsNone: 1 },
    { variant: "caching on", totals: cached, costRatioVsNone: cached.inputCost / baseline.inputCost },
  ];
}

// ---------------------------------------------------------------------------
// experiment 4: turn gap against the TTL

export interface TtlRow {
  gapMs: number;
  ttlLabel: string;
  totals: ReplayTotals;
  costRatioVsNone: number;
}

export function runTtlSweep(seed = DEFAULT_SEED): TtlRow[] {
  const turns = makeConversation(seed + 7, 12);
  const requests = renderConversation(turns);
  const gaps = [60_000, 240_000, 480_000, 1_500_000, 4_200_000];
  const ttls: Array<{ ttlMs: number; label: string }> = [
    { ttlMs: TTL_5M_MS, label: "5m" },
    { ttlMs: TTL_1H_MS, label: "1h" },
  ];
  const rows: TtlRow[] = [];
  for (const gapMs of gaps) {
    const events = requests.map((request, i) => ({ request, arrivalMs: i * gapMs }));
    const baseline = replay(events, none, TTL_5M_MS).inputCost;
    for (const { ttlMs, label } of ttls) {
      const totals = replay(events, incremental, ttlMs);
      rows.push({ gapMs, ttlLabel: label, totals, costRatioVsNone: totals.inputCost / baseline });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// experiment 5: tool-heavy turns against the 20-block lookback window

export interface LookbackRow {
  strategy: string;
  blocksPerTurn: number;
  totals: ReplayTotals;
  costRatioVsNone: number;
}

export function runLookback(seed = DEFAULT_SEED): LookbackRow[] {
  const rows: LookbackRow[] = [];
  for (const toolBlocks of [8, 24]) {
    const events = agentWorkload(seed + 11, 1, 8, 30_000, false, toolBlocks);
    const baseline = replay(events, none, TTL_5M_MS).inputCost;
    for (const [name, strategy] of [
      ["incremental", incremental],
      ["spaced-15", spacedForLookback],
    ] as const) {
      const totals = replay(events, strategy, TTL_5M_MS);
      rows.push({
        strategy: name,
        blocksPerTurn: toolBlocks + 2,
        totals,
        costRatioVsNone: totals.inputCost / baseline,
      });
    }
  }
  return rows;
}
