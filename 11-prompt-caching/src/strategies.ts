/**
 * Breakpoint placement strategies. A strategy maps a rendered request to the
 * block indices that carry a cache breakpoint; the cache does the rest.
 */

import type { RenderedRequest } from "./workload.js";

export type Strategy = (request: RenderedRequest) => number[];

/** No cache_control anywhere: the no-caching baseline. */
export const none: Strategy = () => [];

/** One breakpoint on the static prefix (tools + system), nothing on messages. */
export const staticOnly: Strategy = (request) => [request.staticPrefixEnd];

/**
 * The documented robust combination for agent loops: an explicit breakpoint
 * on the static prefix plus a moving breakpoint on the last block, so each
 * turn reads the whole prior conversation and writes only its own delta.
 */
export const incremental: Strategy = (request) => {
  const last = request.blocks.length - 1;
  return last === request.staticPrefixEnd ? [last] : [request.staticPrefixEnd, last];
};

/**
 * `incremental` plus an extra breakpoint 15 blocks before the tail, keeping
 * every breakpoint within the 20-block lookback of the previous turn's entry
 * even when a turn appends more than 20 blocks.
 */
export const spacedForLookback: Strategy = (request) => {
  const last = request.blocks.length - 1;
  const mid = last - 15;
  const points = [request.staticPrefixEnd, last];
  if (mid > request.staticPrefixEnd && mid < last) points.push(mid);
  return [...new Set(points)].sort((a, b) => a - b);
};

export const STRATEGIES: Record<string, Strategy> = {
  none,
  "static-only": staticOnly,
  incremental,
  "spaced-15": spacedForLookback,
};
