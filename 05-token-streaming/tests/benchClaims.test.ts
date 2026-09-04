/**
 * Measurement 5 held to the evidence it can actually reproduce.
 *
 * The section priced the resumable scanner against the rescan baseline with
 * a `speedup` column — a ratio of two wall clocks — and both readmes quoted
 * it to two significant figures ("57.7x", "662.5x", and in the root index
 * "3.4x faster at 266 chars rising to 662.5x at 64KB") under the claim that
 * the millisecond columns "move a few percent run to run". They do not: on
 * one machine the committed code gave the 8273 row anywhere from 52.8x to
 * 110.1x, and the 65619 row 491.4x to 662.5x. The 1048586-char projection
 * ("~629.2s by the n² law") was derived from the same unstable median and
 * moved with it.
 *
 * The takeaway does not need the clock. The baseline's cost is a character
 * count that is exact and identical every run, and the section already
 * printed one of them. `baselineScanChars` computes that count for any
 * (doc chars, seed, fragment cap) without running the replay, which is what
 * lets the 1048586 row state work instead of projected seconds.
 *
 * These tests hold the new count to a real baseline replay, pin the counts
 * both readmes publish, and hold the prose to ratios that are named as
 * run-dependent instead of quoted as facts.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { chunkOffsets } from "../src/chunker.js";
import { baselineScanChars, makeToolCallJson, replay } from "../src/resumableBench.js";

const SEED = 20260826;
const FRAGMENT_CAP = 24;

const README = new URL("../README.md", import.meta.url);
const ROOT_README = new URL("../../README.md", import.meta.url);

/** Collapse whitespace: a claim that wraps across lines must still match. */
function squash(text: string): string {
  return text.replace(/\s+/g, " ");
}

/** Readme body with the fixes log removed — it quotes the lines it retired. */
function body(url: URL): string {
  return squash(readFileSync(url, "utf-8")).split("## fixes")[0] as string;
}

/** Just measurement 5, so a claim that is fair elsewhere is not banned here. */
function section5(): string {
  const text = body(README);
  const start = text.indexOf("**5. Resumable scan vs full rescan.**");
  const end = text.indexOf("**6. Byte-budgeted backpressure.**");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe("baselineScanChars is the replay's own work count, not an estimate", () => {
  it("agrees with a real baseline replay at every published size it can run", () => {
    for (const target of [256, 1024, 8192]) {
      const json = makeToolCallJson(target, SEED);
      const measured = replay(json, SEED, FRAGMENT_CAP, "baseline").charsScanned;
      expect(baselineScanChars(json.length, SEED, FRAGMENT_CAP)).toBe(measured);
    }
  });

  it("agrees under other seeds and fragment caps", () => {
    for (const seed of [1, 20260904]) {
      for (const cap of [1, 7, 24, 200]) {
        const json = makeToolCallJson(512, seed);
        const measured = replay(json, seed, cap, "baseline").charsScanned;
        expect(baselineScanChars(json.length, seed, cap)).toBe(measured);
      }
    }
  });

  it("is the sum of the prefix lengths the baseline reparses", () => {
    const boundaries = chunkOffsets(500, SEED, FRAGMENT_CAP);
    const sum = boundaries.reduce((total, boundary) => total + boundary, 0);
    expect(baselineScanChars(500, SEED, FRAGMENT_CAP)).toBe(sum);
  });

  it("holds at the degenerate sizes", () => {
    // one char per fragment is the quadratic worst case: 1+2+...+n
    expect(baselineScanChars(100, SEED, 1)).toBe((100 * 101) / 2);
    expect(baselineScanChars(1, SEED, FRAGMENT_CAP)).toBe(1);
    expect(baselineScanChars(0, SEED, FRAGMENT_CAP)).toBe(0);
  });

  it("pins the two counts the readmes publish, including the one too slow to run", () => {
    expect(makeToolCallJson(65536, SEED).length).toBe(65619);
    expect(baselineScanChars(65619, SEED, FRAGMENT_CAP)).toBe(172521764);
    expect(makeToolCallJson(1048576, SEED).length).toBe(1048586);
    expect(baselineScanChars(1048586, SEED, FRAGMENT_CAP)).toBe(44074751901);
  });
});

describe("the project readme prices the scan in work, not in a wall-clock ratio", () => {
  it("no longer publishes a speedup column or its figures", () => {
    const text = section5();
    expect(text).not.toContain("| speedup |");
    expect(text).not.toContain("662.5x");
    expect(text).not.toContain("57.7x");
    expect(text).not.toContain("629.2s");
  });

  it("no longer prices the wall clock at a few percent", () => {
    expect(section5()).not.toContain("move a few percent run to run");
  });

  it("leads on the work counts and carries the exact table", () => {
    const raw = readFileSync(README, "utf-8");
    expect(squash(raw)).toContain("load-bearing column is the work, not the clock");
    expect(raw).toContain("| 266 | 23 | 3365 | 12.7x | 266 |");
    expect(raw).toContain("| 1071 | 88 | 47479 | 44.3x | 1071 |");
    expect(raw).toContain("| 8273 | 662 | 2721000 | 328.9x | 8273 |");
    expect(raw).toContain("| 65619 | 5264 | 172521764 | 2629.1x | 65619 |");
  });

  it("states the 1048586 row as counted work rather than projected seconds", () => {
    const text = section5();
    expect(text).toContain("44074751901 scanned chars, 42032.6x the document");
    expect(text).toContain("counted exactly, not run");
  });

  it("names the ratio as run-dependent and says what was observed", () => {
    const text = section5();
    expect(text).toContain("five runs of this committed code on one machine");
    expect(text).toContain("so no speedup figure is published here");
  });
});

describe("the root readme index row makes the same claim", () => {
  it("drops the two-significant-figure speedup endpoints", () => {
    const text = body(ROOT_README);
    expect(text).not.toContain("3.4x faster at 266 chars rising to 662.5x at 64KB");
  });

  it("carries the work counts instead", () => {
    const text = body(ROOT_README);
    expect(text).toContain(
      "the baseline feeds 172521764 chars through its scanner where the resumable scanner reads 65619",
    );
  });
});
