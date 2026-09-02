/**
 * Entry point for the volatile-position study: run the sweep and print the
 * numbers the readme quotes.
 */

import { DEFAULT_CACHE_CONFIG } from "./cache.js";
import { DEFAULT_PRICING, TTL_5M_MS } from "./pricing.js";
import { DEFAULT_SEED } from "./experiment.js";
import {
  runVolatilePosition,
  VOLATILE_BLOCK_CHARS,
  VOLATILE_GAP_MS,
  VOLATILE_TOOL_BLOCKS_PER_TURN,
  VOLATILE_TURNS,
} from "./volatile-study.js";

const usd = (x: number): string => `$${x.toFixed(4)}`;
const pct = (x: number): string => `${(100 * x).toFixed(1)}%`;
const ratio = (x: number): string => `${x.toFixed(3)}x`;

console.log("volatile block position sweep");
console.log(
  `pricing: $${DEFAULT_PRICING.inputPerMTok}/MTok input, reads ${DEFAULT_PRICING.readMultiplier}x, ` +
    `writes ${DEFAULT_PRICING.writeMultiplierByTtlMs[TTL_5M_MS]}x (5m ttl)`,
);
console.log(
  `cache model: min cacheable prefix ${DEFAULT_CACHE_CONFIG.minCacheableTokens} tokens, ` +
    `max ${DEFAULT_CACHE_CONFIG.maxBreakpoints} breakpoints, ` +
    `${DEFAULT_CACHE_CONFIG.lookbackBlocks}-block lookback, seed ${DEFAULT_SEED}`,
);
console.log(
  `workload: 1 conversation x ${VOLATILE_TURNS} turns, ` +
    `${VOLATILE_TOOL_BLOCKS_PER_TURN + 2} history blocks/turn, ${VOLATILE_GAP_MS / 1000}s gap, ` +
    `one ${VOLATILE_BLOCK_CHARS / 4}-token per-request block inserted at the swept index`,
);
console.log(
  "\neach position prices against its own no-caching baseline; ratio below 1.000 saves money, above loses it",
);

console.log(
  `\n${"position".padEnd(9)}${"final idx".padEnd(11)}${"strategy".padEnd(13)}` +
    `${"input".padEnd(10)}${"ratio".padEnd(9)}${"hit rate".padEnd(10)}uncached/read/write tokens`,
);
for (const row of runVolatilePosition()) {
  const finalIndex = row.finalIndex < 0 ? "-" : String(row.finalIndex);
  console.log(
    `${row.positionLabel.padEnd(9)}${finalIndex.padEnd(11)}${row.strategy.padEnd(13)}` +
      `${usd(row.totals.inputCost).padEnd(10)}${ratio(row.costRatioVsNone).padEnd(9)}` +
      `${pct(row.totals.hitRate).padStart(6).padEnd(10)}` +
      `${row.totals.uncachedTokens}/${row.totals.readTokens}/${row.totals.writeTokens}`,
  );
}
