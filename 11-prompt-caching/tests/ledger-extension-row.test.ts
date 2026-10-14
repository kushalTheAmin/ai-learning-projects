/**
 * The ledger's position-extension row for 11, held to what the sweep prints.
 *
 * `ledgerRow()` in ledger-row.test.ts filters to lines starting
 * `"| 11-prompt-caching |"` and asserts exactly one match, so the
 * ", position extension" row is excluded by construction — and the
 * 2026-09-05 fix that retired "falls monotonically" from the readme never
 * reached it. The row went on publishing a monotone curve with the tail as
 * its bottom, which is the exact claim the dense sweep disproved: the curve
 * turns at 42 and rises back to the tail.
 *
 * These recompute the row's shape claim from a scan over every position the
 * block can occupy, so the row cannot name the wrong minimum again.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { DEFAULT_SEED, replay, type ReplayEvent } from "../src/experiment.js";
import { TTL_5M_MS } from "../src/pricing.js";
import { none } from "../src/strategies.js";
import {
  addVolatileBlock,
  runVolatilePosition,
  volatileAware,
  VOLATILE_GAP_MS,
  VOLATILE_TOOL_BLOCKS_PER_TURN,
  VOLATILE_TURNS,
  type VolatileRenderedRequest,
} from "../src/volatile-study.js";
import { makeConversation, renderConversation } from "../src/workload.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ratio = (x: number): string => `${x.toFixed(3)}x`;

/** The extension row, which the base row's ledger test deliberately skips. */
function extensionRow(): string {
  const text = readFileSync(resolve(projectRoot, "../progress.md"), "utf8");
  const completed = text.split("## COMPLETED", 1 + 1)[1]!.split("\n## ", 1)[0]!;
  const rows = completed
    .split("\n")
    .filter((line) => line.startsWith("| 11-prompt-caching, position extension |"));
  expect(rows, "progress.md has no single extension row for 11").toHaveLength(1);
  return rows[0]!;
}

/** The study's own conversation, reproduced turn for turn. */
const base = renderConversation(
  makeConversation(DEFAULT_SEED + 21, VOLATILE_TURNS, VOLATILE_TOOL_BLOCKS_PER_TURN),
);
const TAIL_INDEX = base[base.length - 1]!.blocks.length - 1;

function awareRatio(position: number): number {
  const requests = addVolatileBlock(base, position);
  const events: ReplayEvent<VolatileRenderedRequest>[] = requests.map((request, i) => ({
    request,
    arrivalMs: i * VOLATILE_GAP_MS,
  }));
  const baseline = replay(events, none, TTL_5M_MS).inputCost;
  return replay(events, volatileAware, TTL_5M_MS).inputCost / baseline;
}

/** Every position, not just the nine the table samples. */
const dense = Array.from({ length: TAIL_INDEX + 1 }, (_, p) => ({ position: p, ratio: awareRatio(p) }));
const best = dense.reduce((a, b) => (b.ratio < a.ratio ? b : a));
const stableFloor = runVolatilePosition().find((row) => row.positionLabel === "stable")!.costRatioVsNone;

describe("the ledger's position-extension row for 11", () => {
  it("there is exactly one, and it is the extension not the base row", () => {
    const row = extensionRow();
    expect(row).toContain("position extension");
    expect(row).toContain("volatile-position study");
  });

  it("quotes the curve the dense scan measures, minimum and rise included", () => {
    const shape =
      `the aware curve falls steeply and then turns back up before the tail, ` +
      `${ratio(dense[0]!.ratio)} at position 0 to ${ratio(dense[2]!.ratio)} at position 2, ` +
      `bottoming at ${ratio(best.ratio)} at position ${best.position} and rising to ` +
      `${ratio(dense[TAIL_INDEX]!.ratio)} at the tail, against the ${ratio(stableFloor)} stable floor`;
    expect(shape).toContain("1.000x at position 0 to 0.722x at position 2");
    expect(shape).toContain("bottoming at 0.299x at position 42 and rising to 0.301x at the tail");
    expect(extensionRow()).toContain(shape);
  });

  it("no longer calls the curve monotone or reads the tail as its bottom", () => {
    const row = extensionRow();
    expect(row).not.toContain("falls monotonically");
    // the retired shape: position 2 straight to the tail, tail against the floor
    expect(row).not.toContain(
      `${ratio(dense[2]!.ratio)} at position 2 to ${ratio(dense[TAIL_INDEX]!.ratio)} at the tail`,
    );
  });

  it("the scan still puts the minimum before the tail", () => {
    expect(TAIL_INDEX).toBe(46);
    expect(best.position).toBeLessThan(TAIL_INDEX);
    expect(dense[TAIL_INDEX]!.ratio).toBeGreaterThan(best.ratio);
    // and the floor the row names is the no-volatile run, cheaper than either
    expect(stableFloor).toBeLessThan(best.ratio);
  });
});
