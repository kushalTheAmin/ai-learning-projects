import { describe, expect, it } from "vitest";
import {
  heavyTailedSizes,
  uniformSizes,
  shuffled,
  summarizeWorkload,
  replayThroughQueue,
} from "../src/byteQueueStudy.js";

describe("workload generation", () => {
  it("is deterministic per seed and lands every size in a declared band", () => {
    const first = heavyTailedSizes(500, 7);
    const second = heavyTailedSizes(500, 7);
    expect(second).toEqual(first);
    for (const size of first) {
      const inBand =
        (size >= 3 && size <= 30) || (size >= 200 && size <= 2000) || (size >= 16384 && size <= 32768);
      expect(inBand).toBe(true);
    }
  });

  it("spans at least 1000x between the smallest and largest chunk", () => {
    const sizes = heavyTailedSizes(2000, 20260901);
    const min = Math.min(...sizes);
    const max = Math.max(...sizes);
    expect(max / min).toBeGreaterThanOrEqual(1000);
    // all three bands are represented
    expect(sizes.some((s) => s <= 30)).toBe(true);
    expect(sizes.some((s) => s >= 200 && s <= 2000)).toBe(true);
    expect(sizes.some((s) => s >= 16384)).toBe(true);
  });

  it("keeps uniform sizes inside the requested range", () => {
    const sizes = uniformSizes(300, 5, 1, 24);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(24);
    expect(uniformSizes(300, 5, 1, 24)).toEqual(sizes);
  });
});

describe("shuffled", () => {
  it("returns a deterministic permutation and leaves the input untouched", () => {
    const sizes = [1, 2, 3, 4, 5, 6, 7, 8];
    const copy = [...sizes];
    const once = shuffled(sizes, 3);
    expect(sizes).toEqual(copy);
    expect(shuffled(sizes, 3)).toEqual(once);
    expect([...once].sort((a, b) => a - b)).toEqual(copy);
    expect(shuffled(sizes, 4)).not.toEqual(once);
  });
});

describe("summarizeWorkload", () => {
  it("computes totals, order statistics, and the huge-chunk byte share", () => {
    const summary = summarizeWorkload([1, 10, 100], 50);
    expect(summary.count).toBe(3);
    expect(summary.totalBytes).toBe(111);
    expect(summary.minSize).toBe(1);
    expect(summary.medianSize).toBe(10);
    expect(summary.maxSize).toBe(100);
    expect(summary.hugeCount).toBe(1);
    expect(summary.hugeByteShare).toBeCloseTo(100 / 111, 10);
  });

  it("handles an empty workload", () => {
    const summary = summarizeWorkload([], 10);
    expect(summary.count).toBe(0);
    expect(summary.totalBytes).toBe(0);
    expect(summary.hugeByteShare).toBe(0);
  });
});

describe("replayThroughQueue", () => {
  it("delivers an empty and a single-chunk workload", async () => {
    const empty = await replayThroughQueue([], { maxBytes: 100 });
    expect(empty.consumed).toBe(0);
    expect(empty.meanBufferedBytes).toBe(0);
    const single = await replayThroughQueue([9000], { maxBytes: 100 });
    expect(single.consumed).toBe(1);
    expect(single.oversizedPushes).toBe(1);
  });

  it("delivers every chunk under item caps, byte caps, and no cap", async () => {
    const sizes = heavyTailedSizes(300, 11);
    for (const limits of [{}, { maxItems: 2 }, { maxBytes: 65536 }, { maxItems: 8, maxBytes: 4096 }]) {
      const run = await replayThroughQueue(sizes, limits);
      expect(run.consumed).toBe(sizes.length);
    }
  });

  it("holds the byte promise under an adversarial ordering where the count cap blows up", async () => {
    const sizes = [...Array.from({ length: 8 }, () => 8000), ...Array.from({ length: 40 }, () => 10)];
    const count8 = await replayThroughQueue(sizes, { maxItems: 8 });
    const byte8000 = await replayThroughQueue(sizes, { maxBytes: 8000 });
    // the consumer's first take lands before the buffer fills all 8 slots,
    // so the peak is 7 huge chunks plus small admissions, not the full 8
    expect(count8.bytesHighWater).toBeGreaterThan(6 * 8000);
    expect(byte8000.bytesHighWater).toBeLessThanOrEqual(8000);
    expect(byte8000.oversizedPushes).toBe(0);
  });

  it("bounds buffered bytes by the largest chunk when the budget sits below it", async () => {
    const run = await replayThroughQueue([10, 9000, 10, 10], { maxBytes: 1000 });
    expect(run.bytesHighWater).toBe(9000);
    expect(run.oversizedPushes).toBe(1);
    expect(run.consumed).toBe(4);
  });

  it("reports identical numbers on identical replays", async () => {
    const sizes = heavyTailedSizes(200, 13);
    const pacing = { burstChunks: 20, gapTicks: 10 };
    const first = await replayThroughQueue(sizes, { maxBytes: 30000 }, pacing);
    const second = await replayThroughQueue(sizes, { maxBytes: 30000 }, pacing);
    expect(second).toEqual(first);
  });

  it("shows a bursty producer starving a shallow count cap but not an equal-promise byte cap", async () => {
    const sizes = heavyTailedSizes(300, 20260901);
    const pacing = { burstChunks: 50, gapTicks: 25 };
    const count2 = await replayThroughQueue(sizes, { maxItems: 2 }, pacing);
    const byte64k = await replayThroughQueue(sizes, { maxBytes: 65536 }, pacing);
    // both promise at most 65536 buffered bytes (2 x 32768 = 65536)
    expect(count2.bytesHighWater).toBeLessThanOrEqual(65536);
    expect(byte64k.bytesHighWater).toBeLessThanOrEqual(65536);
    // but only the byte cap buffers deep enough to ride out the gaps
    expect(count2.consumerIdleTicks).toBeGreaterThan(0);
    expect(byte64k.consumerIdleTicks).toBeLessThan(count2.consumerIdleTicks);
    expect(byte64k.meanBufferedBytes).toBeGreaterThan(count2.meanBufferedBytes);
  });
});
