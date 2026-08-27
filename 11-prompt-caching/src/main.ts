/**
 * Entry point: run every experiment and print the numbers the readme quotes.
 */

import { DEFAULT_PRICING, TTL_5M_MS, TTL_1H_MS } from "./pricing.js";
import { DEFAULT_CACHE_CONFIG } from "./cache.js";
import {
  DEFAULT_SEED,
  runLookback,
  runOneShot,
  runStrategyComparison,
  runTtlSweep,
  runVolatileHeader,
  type ReplayTotals,
} from "./experiment.js";

const usd = (x: number): string => `$${x.toFixed(4)}`;
const pct = (x: number): string => `${(100 * x).toFixed(1)}%`;
const ratio = (x: number): string => `${x.toFixed(3)}x`;

function tokensLine(t: ReplayTotals): string {
  return `uncached ${t.uncachedTokens}, read ${t.readTokens}, write ${t.writeTokens}`;
}

console.log("prompt caching cost simulation");
console.log(
  `pricing: $${DEFAULT_PRICING.inputPerMTok}/MTok input, reads ${DEFAULT_PRICING.readMultiplier}x, ` +
    `writes ${DEFAULT_PRICING.writeMultiplierByTtlMs[TTL_5M_MS]}x (5m ttl) / ` +
    `${DEFAULT_PRICING.writeMultiplierByTtlMs[TTL_1H_MS]}x (1h ttl)`,
);
console.log(
  `cache model: min cacheable prefix ${DEFAULT_CACHE_CONFIG.minCacheableTokens} tokens, ` +
    `max ${DEFAULT_CACHE_CONFIG.maxBreakpoints} breakpoints, ` +
    `${DEFAULT_CACHE_CONFIG.lookbackBlocks}-block lookback, seed ${DEFAULT_SEED}`,
);

console.log("\n== 1. breakpoint strategy, 6 interleaved conversations x 10 turns, 30s mean gap ==");
for (const row of runStrategyComparison()) {
  console.log(
    `${row.strategy.padEnd(12)} input ${usd(row.totals.inputCost)}  saved ${pct(row.savingsVsNone).padStart(6)}  ` +
      `hit rate ${pct(row.totals.hitRate).padStart(6)}  (${tokensLine(row.totals)})`,
  );
}

console.log("\n== 2. volatile header in the system prompt (incremental breakpoints) ==");
for (const row of runVolatileHeader()) {
  console.log(
    `${row.variant.padEnd(16)} input ${usd(row.totals.inputCost)}  ${ratio(row.costRatioVsNone)} of no-caching  ` +
      `hit rate ${pct(row.totals.hitRate).padStart(6)}  hits ${row.totals.requestsWithHit}/${row.totals.requests}`,
  );
}

console.log("\n== 3. one-shot requests (40 unique prompts) with caching left on ==");
for (const row of runOneShot()) {
  console.log(
    `${row.variant.padEnd(12)} input ${usd(row.totals.inputCost)}  ${ratio(row.costRatioVsNone)} of no-caching  ` +
      `(${tokensLine(row.totals)})`,
  );
}

console.log("\n== 4. turn gap vs ttl, 1 conversation x 12 turns, incremental breakpoints ==");
console.log("cost ratio vs no caching (below 1.000 saves money, above 1.000 loses it)");
for (const row of runTtlSweep()) {
  console.log(
    `gap ${(row.gapMs / 60_000).toFixed(0).padStart(3)}m  ttl ${row.ttlLabel.padEnd(3)} ` +
      `input ${usd(row.totals.inputCost)}  ${ratio(row.costRatioVsNone)}  hits ${row.totals.requestsWithHit}/${row.totals.requests}`,
  );
}

console.log("\n== 5. tool-heavy turns vs the 20-block lookback, 1 conversation x 8 turns ==");
for (const row of runLookback()) {
  console.log(
    `${String(row.blocksPerTurn).padStart(2)} blocks/turn  ${row.strategy.padEnd(12)} ` +
      `input ${usd(row.totals.inputCost)}  ${ratio(row.costRatioVsNone)} of no-caching  ` +
      `hit rate ${pct(row.totals.hitRate).padStart(6)}  (${tokensLine(row.totals)})`,
  );
}
