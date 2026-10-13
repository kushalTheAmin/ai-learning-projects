/**
 * The 1048586-char row held to the same rule as the rest of measurement 5.
 *
 * The 2026-09-04 fix retired the section's whole `speedup` column because two
 * significant figures of wall clock move further than the figure does, and the
 * table that survived says so in as many words ("those four are one run and
 * the ratio between the two time columns is not a property of the code"). The
 * paragraph underneath it kept a clock anyway: "finishes the whole replay in
 * 76.0ms over 84070 fragments, about 0.9µs per fragment", stated flat, with
 * the open question below then reasoning off it ("`view()` per fragment is
 * ~0.8µs"). No run reproduces either number — six observations of this
 * committed code land between 109.9ms and 132.9ms, 1.31 to 1.58µs per
 * fragment, every one further from 76.0ms than the spread the section quotes
 * for its own 8273 and 65619 rows, and four more runs here land 121.2ms to
 * 132.9ms.
 *
 * What the row can actually claim is counted, not timed: the fragment count
 * and the baseline's scanned chars are exact and identical every run. These
 * tests pin those against the bench that computes them, and hold the prose to
 * naming the clock run-dependent instead of publishing a figure for it.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { chunkOffsets } from "../src/chunker.js";
import { baselineScanChars, makeToolCallJson } from "../src/resumableBench.js";

const SEED = 20260826;
const FRAGMENT_CAP = 24;

const README = new URL("../README.md", import.meta.url);

function squash(text: string): string {
  return text.replace(/\s+/g, " ");
}

/** Readme body with the fixes log removed — it quotes the lines it retired. */
function body(): string {
  return squash(readFileSync(README, "utf-8")).split("## fixes")[0] as string;
}

/** Just measurement 5, so a clock that is fair elsewhere is not banned here. */
function section5(): string {
  const text = body();
  const start = text.indexOf("**5. Resumable scan vs full rescan.**");
  const end = text.indexOf("**6. Byte-budgeted backpressure.**");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

/** The open-questions bullet that used to reason off the retired figure. */
function viewCostQuestion(): string {
  const text = squash(readFileSync(README, "utf-8"));
  const start = text.indexOf("- `view()` per fragment");
  expect(start).toBeGreaterThan(-1);
  return text.slice(start, start + 400);
}

describe("the 1048586 row's counted claims are the bench's own numbers", () => {
  it("publishes the document size the generator actually produces", () => {
    expect(makeToolCallJson(1048576, SEED).length).toBe(1048586);
    expect(section5()).toContain("1048586");
  });

  it("publishes the fragment count the chunker actually produces", () => {
    expect(chunkOffsets(1048586, SEED, FRAGMENT_CAP).length).toBe(84070);
    expect(section5()).toContain("84070 fragments");
  });

  it("publishes the baseline's scanned chars and ratio as counted", () => {
    const scan = baselineScanChars(1048586, SEED, FRAGMENT_CAP);
    expect(scan).toBe(44074751901);
    expect((scan / 1048586).toFixed(1)).toBe("42032.6");
    const text = section5();
    expect(text).toContain("44074751901 scanned chars, 42032.6x the document");
    expect(text).toContain("counted exactly, not run");
  });

  it("says the resumable side reads each char once, which is the counted claim", () => {
    expect(baselineScanChars(1048586, SEED, FRAGMENT_CAP)).toBeGreaterThan(1048586);
    expect(section5()).toContain("reads each of those 1048586 chars once");
  });
});

describe("the 1048586 row publishes no wall-clock figure", () => {
  it("drops the retired 76.0ms and its per-fragment restatement", () => {
    const text = section5();
    expect(text).not.toContain("76.0ms");
    expect(text).not.toContain("0.9µs");
  });

  it("states no millisecond figure against the fragment count at all", () => {
    // the shape the fix removed: "<n>ms over 84070 fragments"
    expect(section5()).not.toMatch(/[\d.]+\s*ms over 84070 fragments/);
  });

  it("quotes no per-fragment microsecond figure anywhere in the section", () => {
    expect(section5()).not.toMatch(/[\d.]+\s*µs per fragment/);
  });

  it("names the clock run-dependent and says what was observed instead", () => {
    const text = section5();
    expect(text).toContain("run-dependent");
    expect(text).toContain("109.9ms and 132.9ms");
    expect(text).toContain("repeated runs of this committed code");
    expect(text).toContain("observations, not a bound");
  });
});

describe("the open question no longer reasons off a published microsecond figure", () => {
  it("drops the ~0.8µs constant", () => {
    expect(viewCostQuestion()).not.toContain("0.8µs");
  });

  it("keeps the conclusion, on an order of magnitude rather than a figure", () => {
    const text = viewCostQuestion();
    expect(text).toContain("single microseconds");
    expect(text).toContain("the consumer reacting to every fragment");
  });
});
