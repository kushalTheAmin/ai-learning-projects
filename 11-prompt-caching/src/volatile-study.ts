/**
 * The volatile-position study. The volatile-header experiment put a
 * per-request line at block 1 and killed every hit; prefix matching says a
 * volatile block at index k should only kill the cache from k onward. This
 * study inserts one constant-size per-request block at a configurable index,
 * sweeps the index across the request, and replays the same conversation
 * under two operators: one that places breakpoints as if the request were
 * fully stable (the documented incremental combination), and one that knows
 * where the volatile block sits and refuses to mark anything at or past it.
 */

import type { Block } from "./cache.js";
import { TTL_5M_MS } from "./pricing.js";
import { incremental, none } from "./strategies.js";
import { DEFAULT_SEED, replay, type ReplayEvent, type ReplayTotals } from "./experiment.js";
import { makeConversation, renderConversation, type RenderedRequest } from "./workload.js";

/** Sentinel position: the volatile block sits just before the user message. */
export const TAIL_POSITION = Number.POSITIVE_INFINITY;

export interface VolatileRenderedRequest extends RenderedRequest {
  /** Index the volatile block landed on after clamping. */
  volatileIndex: number;
}

/** Constant size so every position bills the same prospective tokens. */
export const VOLATILE_BLOCK_CHARS = 480;

function volatileText(salt: number, requestIndex: number): string {
  const header = `state snapshot ${salt}:${requestIndex}.`;
  const filler = " open files 3, dirty buffers 1, last exit 0, branch main, watcher idle.";
  let text = header;
  while (text.length < VOLATILE_BLOCK_CHARS) text += filler;
  return text.slice(0, VOLATILE_BLOCK_CHARS);
}

/**
 * Insert one per-request volatile block at `position` into each rendered
 * request. The index is clamped to sit at latest directly before the final
 * user message, so early requests shorter than `position` carry the block at
 * their tail until the conversation grows past it.
 */
export function addVolatileBlock(
  requests: readonly RenderedRequest[],
  position: number,
  salt = 0,
): VolatileRenderedRequest[] {
  if (position !== TAIL_POSITION && (!Number.isInteger(position) || position < 0)) {
    throw new Error(`volatile position must be a non-negative integer or TAIL_POSITION, got ${position}`);
  }
  return requests.map((request, i) => {
    const volatileIndex = Math.min(position, request.blocks.length - 1);
    const blocks: Block[] = [...request.blocks];
    blocks.splice(volatileIndex, 0, { text: volatileText(salt, i) });
    return {
      ...request,
      blocks,
      staticPrefixEnd:
        volatileIndex <= request.staticPrefixEnd ? request.staticPrefixEnd + 1 : request.staticPrefixEnd,
      volatileIndex,
    };
  });
}

/**
 * Breakpoints for an operator who knows where the volatile block sits: the
 * deepest stable index (one before the volatile block) plus the static
 * prefix when it survives, and nothing at or past the volatile block, since
 * an entry containing it can never be read back.
 */
export function volatileAware(request: VolatileRenderedRequest): number[] {
  const points = [request.staticPrefixEnd, request.volatileIndex - 1].filter(
    (index) => index >= 0 && index < request.volatileIndex,
  );
  return [...new Set(points)].sort((a, b) => a - b);
}

export interface VolatilePositionRow {
  positionLabel: string;
  strategy: string;
  /** Volatile index in the final (deepest) request, -1 for the stable row. */
  finalIndex: number;
  totals: ReplayTotals;
  costRatioVsNone: number;
}

export const SWEEP_POSITIONS: ReadonlyArray<{ label: string; position: number }> = [
  { label: "0", position: 0 },
  { label: "1", position: 1 },
  { label: "2", position: 2 },
  { label: "6", position: 6 },
  { label: "14", position: 14 },
  { label: "22", position: 22 },
  { label: "30", position: 30 },
  { label: "38", position: 38 },
  { label: "tail", position: TAIL_POSITION },
];

export const VOLATILE_TURNS = 12;
export const VOLATILE_TOOL_BLOCKS_PER_TURN = 2;
export const VOLATILE_GAP_MS = 30_000;

/**
 * One conversation, 12 turns, 4 history blocks per turn, 30s between turns
 * (well inside the 5m ttl, so expiry never confounds position). Every
 * position replays the identical conversation with the identical volatile
 * token count; only where the block sits changes.
 */
export function runVolatilePosition(seed = DEFAULT_SEED): VolatilePositionRow[] {
  const turns = makeConversation(seed + 21, VOLATILE_TURNS, VOLATILE_TOOL_BLOCKS_PER_TURN);
  const base = renderConversation(turns);
  const rows: VolatilePositionRow[] = [];
  for (const { label, position } of SWEEP_POSITIONS) {
    const requests = addVolatileBlock(base, position);
    const events: ReplayEvent<VolatileRenderedRequest>[] = requests.map((request, i) => ({
      request,
      arrivalMs: i * VOLATILE_GAP_MS,
    }));
    const baseline = replay(events, none, TTL_5M_MS).inputCost;
    const finalIndex = requests[requests.length - 1]!.volatileIndex;
    for (const [name, strategy] of [
      ["incremental", incremental],
      ["aware", volatileAware],
    ] as const) {
      const totals = replay(events, strategy, TTL_5M_MS);
      rows.push({
        positionLabel: label,
        strategy: name,
        finalIndex,
        totals,
        costRatioVsNone: totals.inputCost / baseline,
      });
    }
  }
  const stableEvents: ReplayEvent[] = base.map((request, i) => ({
    request,
    arrivalMs: i * VOLATILE_GAP_MS,
  }));
  const stableBaseline = replay(stableEvents, none, TTL_5M_MS).inputCost;
  const stableTotals = replay(stableEvents, incremental, TTL_5M_MS);
  rows.push({
    positionLabel: "stable",
    strategy: "incremental",
    finalIndex: -1,
    totals: stableTotals,
    costRatioVsNone: stableTotals.inputCost / stableBaseline,
  });
  return rows;
}
