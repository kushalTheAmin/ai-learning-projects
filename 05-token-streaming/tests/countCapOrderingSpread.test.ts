/**
 * Measurement 6's ordering-luck ratio held to the orders it is read off.
 *
 * The section prints count cap 8's peak memory under six arrival orders —
 * five seeded (as generated, four shuffles) and one adversarial (all huge
 * chunks first) — and then states the spread as a ratio: "the five seeded
 * orders sit between 35570 and 59971 bytes, and the adversarial order ...
 * holds 221864, 4.5x the friendliest seed". 4.5x is 221864/49061, the
 * as-generated order, which is the fourth-friendliest of the five. The
 * friendliest is shuffle 3 at 35570, and the hostile order is 6.2x that.
 *
 * The understatement runs the wrong way for the section's own argument, so
 * nothing downstream was wrong — but the published ratio did not come from
 * the comparison the sentence names. These tests pin each ordering's peak to
 * a real replay, pin the ratio to the friendliest of the five, and hold the
 * readme to that basis.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { heavyTailedSizes, shuffled, replayThroughQueue } from "../src/byteQueueStudy.js";

const SEED = 20260901;
const COUNT_CAP = 8;

const README = new URL("../README.md", import.meta.url);

/** Collapse whitespace: a claim that wraps across lines must still match. */
function squash(text: string): string {
  return text.replace(/\s+/g, " ");
}

/** Readme body with the fixes log removed — it quotes the lines it retired. */
function body(): string {
  return squash(readFileSync(README, "utf-8")).split("## fixes")[0] as string;
}

const sizes = heavyTailedSizes(2000, SEED);

/** The six arrival orders measurement 6 prints, in the order it prints them. */
function orderings(): { label: string; order: number[]; seeded: boolean }[] {
  return [
    { label: "as generated", order: sizes, seeded: true },
    { label: "shuffle 1", order: shuffled(sizes, 1), seeded: true },
    { label: "shuffle 2", order: shuffled(sizes, 2), seeded: true },
    { label: "shuffle 3", order: shuffled(sizes, 3), seeded: true },
    { label: "shuffle 4", order: shuffled(sizes, 4), seeded: true },
    { label: "huge first", order: [...sizes].sort((a, b) => b - a), seeded: false },
  ];
}

async function peaks(): Promise<{ label: string; peak: number; seeded: boolean }[]> {
  const out: { label: string; peak: number; seeded: boolean }[] = [];
  for (const { label, order, seeded } of orderings()) {
    const run = await replayThroughQueue(order, { maxItems: COUNT_CAP });
    out.push({ label, peak: run.bytesHighWater, seeded });
  }
  return out;
}

describe("count cap 8's peak memory across the six arrival orders", () => {
  it("pins every peak the readme table publishes", async () => {
    const measured = await peaks();
    expect(measured.map(({ label, peak }) => `${label} ${peak}`)).toEqual([
      "as generated 49061",
      "shuffle 1 59971",
      "shuffle 2 54583",
      "shuffle 3 35570",
      "shuffle 4 35750",
      "huge first 221864",
    ]);
  });

  it("puts the friendliest seeded order at 35570, not at the as-generated 49061", async () => {
    const seeded = (await peaks()).filter((row) => row.seeded);
    expect(seeded).toHaveLength(5);
    const friendliest = seeded.reduce((best, row) => (row.peak < best.peak ? row : best));
    expect(friendliest.label).toBe("shuffle 3");
    expect(friendliest.peak).toBe(35570);
    // the order the retired ratio was actually read off
    expect(seeded.filter((row) => row.peak < 49061)).toHaveLength(2);
  });

  it("prices the hostile order at 6.2x the friendliest seeded order", async () => {
    const measured = await peaks();
    const hostile = measured.find((row) => row.label === "huge first") as { peak: number };
    const friendliest = Math.min(...measured.filter((row) => row.seeded).map((row) => row.peak));
    expect((hostile.peak / friendliest).toFixed(1)).toBe("6.2");
    // 4.5x is the as-generated order, which is not the friendliest of the five
    expect((hostile.peak / 49061).toFixed(1)).toBe("4.5");
  });
});

describe("the readme states the ratio against the order it is read off", () => {
  it("no longer calls 4.5x the friendliest seed", () => {
    expect(body()).not.toContain("4.5x the friendliest seed");
  });

  it("prices the hostile order at 6.2x the friendliest of the five", () => {
    expect(body()).toContain("holds 221864, 6.2x the friendliest of those five");
  });

  it("still publishes the spread the ratio is taken from", () => {
    const text = body();
    expect(text).toContain("the five seeded orders sit between 35570 and 59971 bytes");
    expect(text).toContain("8 x 32706 = 261648 bytes");
  });
});
