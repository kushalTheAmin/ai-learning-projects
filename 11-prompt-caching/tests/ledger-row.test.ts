/**
 * The repo ledger's COMPLETED row for 11, held to what `npm start` prints.
 *
 * The row in ../../progress.md is the summary another project reads before
 * reusing a mechanism from here, and it quotes measured figures. Nothing
 * bound them to the harness, so the 2026-08-29 fix that gave the volatile
 * variant its own no-caching baseline moved the row's ratio 1.252x to
 * 1.250x in the readme and left the ledger quoting the pre-fix value for 39
 * days. 03's row grew the same drift off the 2026-08-27 stemmer fix, and
 * 07's shipped an actually-wrong recall the same way.
 *
 * These recompute every measured figure in the row from the same
 * experiment functions `src/main.ts` prints, so the row cannot be typed
 * stale again.
 */

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import { DEFAULT_CACHE_CONFIG } from "../src/cache.js";
import {
  runLookback,
  runOneShot,
  runStrategyComparison,
  runTtlSweep,
  runVolatileHeader,
} from "../src/experiment.js";

const pct = (x: number): string => `${(100 * x).toFixed(1)}%`;
const ratio = (x: number): string => `${x.toFixed(3)}x`;

/** The one COMPLETED row for 11, two directories up. */
function ledgerRow(): string {
  const text = readFileSync(new URL("../../progress.md", import.meta.url), "utf-8");
  // The REVIEWED table keys its rows by project name too, so scope to the
  // COMPLETED section first or that date row comes back as a second match.
  const completed = text.split("## COMPLETED", 1 + 1)[1]!.split("\n## ", 1)[0]!;
  const rows = completed
    .split("\n")
    // the trailing pipe is what separates the base row from the
    // "| 11-prompt-caching, position extension |" row above it
    .filter((line) => line.startsWith("| 11-prompt-caching |"));
  expect(rows, "progress.md has no single COMPLETED row for 11").toHaveLength(1);
  return rows[0]!;
}

describe("the ledger's completed row for 11", () => {
  test("there is exactly one, and it is the base row not the extension", () => {
    const row = ledgerRow();
    expect(row.startsWith("| 11-prompt-caching |")).toBe(true);
    expect(row).not.toContain("position extension");
  });

  test("row quotes the volatile header ratio the run computes", () => {
    // The figure the 2026-08-29 own-baseline fix moved out from under.
    const rows = runVolatileHeader();
    const volatile = rows.find((r) => r.variant === "volatile header")!;
    expect(ratio(volatile.costRatioVsNone)).toBe("1.250x");
    expect(ledgerRow()).toContain(`lands at ${ratio(volatile.costRatioVsNone)} of not caching`);
  });

  test("row does not carry the pre-own-baseline ratio", () => {
    // 1.252x is the retired reading, and 1.250x is not a prefix of it.
    expect(ledgerRow()).not.toContain("1.252");
  });

  test("row quotes the volatile header's hit collapse", () => {
    const rows = runVolatileHeader();
    const stable = rows.find((r) => r.variant === "stable header")!;
    const volatile = rows.find((r) => r.variant === "volatile header")!;
    const collapse =
      `drops hits ${stable.totals.requestsWithHit}/${stable.totals.requests} ` +
      `to ${volatile.totals.requestsWithHit}/${volatile.totals.requests}`;
    expect(collapse).toBe("drops hits 59/60 to 0/60");
    expect(ledgerRow()).toContain(collapse);
  });

  test("row quotes experiment 1's savings and hit rate", () => {
    const rows = runStrategyComparison();
    const incremental = rows.find((r) => r.strategy === "incremental")!;
    const staticOnly = rows.find((r) => r.strategy === "static-only")!;
    const saved = pct(incremental.savingsVsNone);
    const hitRate = pct(incremental.totals.hitRate);
    const staticSaved = pct(staticOnly.savingsVsNone);
    expect([saved, hitRate, staticSaved]).toEqual(["78.0%", "89.6%", "44.2%"]);
    const row = ledgerRow();
    expect(row).toContain(`save ${saved} input cost vs no caching (hit rate ${hitRate})`);
    expect(row).toContain(`static-only saves ${staticSaved}`);
  });

  test("row quotes the one-shot ratio", () => {
    const cached = runOneShot().find((r) => r.variant === "caching on")!;
    expect(ratio(cached.costRatioVsNone)).toBe("1.250x");
    expect(ledgerRow()).toContain(
      `one-shot prompts with caching on bill exactly ${ratio(cached.costRatioVsNone)}`,
    );
  });

  test("row quotes the four corners of the ttl sweep", () => {
    const rows = runTtlSweep();
    const at = (gapMs: number, ttlLabel: string): string =>
      ratio(rows.find((r) => r.gapMs === gapMs && r.ttlLabel === ttlLabel)!.costRatioVsNone);
    const quoted = [at(60_000, "5m"), at(480_000, "5m"), at(60_000, "1h"), at(4_200_000, "1h")];
    expect(quoted).toEqual(["0.246x", "1.250x", "0.341x", "2.000x"]);
    const row = ledgerRow();
    expect(row).toContain(`flips the 5m ttl from ${quoted[0]} to a pure ${quoted[1]} loss`);
    expect(row).toContain(`1h ttl holds ${quoted[2]} until 70m, then ${quoted[3]}`);
  });

  test("row quotes experiment 5's two lookback ratios and the window", () => {
    const rows = runLookback();
    const at = (blocksPerTurn: number, strategy: string): string =>
      ratio(
        rows.find((r) => r.blocksPerTurn === blocksPerTurn && r.strategy === strategy)!
          .costRatioVsNone,
      );
    const naive = at(26, "incremental");
    const spaced = at(26, "spaced-15");
    expect([naive, spaced]).toEqual(["1.072x", "0.362x"]);
    const row = ledgerRow();
    expect(row).toContain(`(${naive}, worse than no caching)`);
    expect(row).toContain(`restores ${spaced}`);
    // and the window the sentence is about, which the 2026-10-07 fix touched
    expect(row).toContain(`26-block turns outrun the ${DEFAULT_CACHE_CONFIG.lookbackBlocks}-block lookback`);
    expect(row).toContain(`${DEFAULT_CACHE_CONFIG.lookbackBlocks}-block lookback per breakpoint`);
  });
});
