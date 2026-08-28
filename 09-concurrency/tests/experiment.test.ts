import { describe, expect, it } from "vitest";
import {
  ISOLATION,
  runBatchSizeSweep,
  runIsolationSweep,
  runMicroBatchSweep,
  runWorkerSweep,
} from "../src/experiment.js";
import type { IsolationRow } from "../src/experiment.js";

const SMALL_WORKERS = { seed: 7, taskCount: 40, limits: [1, 4, 8, 16] };
const SMALL_BATCHES = { seed: 7, itemCount: 48, clientConcurrency: 4, batchSizes: [1, 4, 16] };
const SMALL_MICRO = {
  seed: 7,
  itemCount: 80,
  meanInterArrivalMs: 20,
  maxBatchSize: 8,
  maxWaits: [0, 40, 160],
};

describe("worker sweep", () => {
  it("is deterministic run to run", async () => {
    expect(await runWorkerSweep(SMALL_WORKERS)).toEqual(await runWorkerSweep(SMALL_WORKERS));
  });

  it("scales makespan down until the server cap, then flatlines while latency inflates", async () => {
    const [w1, w4, w8, w16] = await runWorkerSweep(SMALL_WORKERS);
    expect(w1!.makespanMs).toBeGreaterThan(w4!.makespanMs);
    expect(w4!.makespanMs).toBeGreaterThan(w8!.makespanMs);
    // Past the cap the extra client workers buy no makespan at all...
    expect(w16!.makespanMs).toBeCloseTo(w8!.makespanMs, 6);
    // ...they only move queueing onto the server and inflate observed latency.
    expect(w16!.requestP95Ms).toBeGreaterThan(1.5 * w8!.requestP95Ms);
    expect(w8!.serverQueueP95Ms).toBe(0);
    expect(w16!.serverQueueP95Ms).toBeGreaterThan(0);
    expect(w16!.concurrencyHighWater).toBe(16);
  });
});

describe("batch size sweep", () => {
  it("is deterministic run to run", async () => {
    expect(await runBatchSizeSweep(SMALL_BATCHES)).toEqual(await runBatchSizeSweep(SMALL_BATCHES));
  });

  it("makes each call slower and each item cheaper as the batch grows", async () => {
    const rows = await runBatchSizeSweep(SMALL_BATCHES);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.inputTokensPerItem).toBeLessThan(rows[i - 1]!.inputTokensPerItem);
      expect(rows[i]!.usdPer1kItems).toBeLessThan(rows[i - 1]!.usdPer1kItems);
      expect(rows[i]!.callP50Ms).toBeGreaterThan(rows[i - 1]!.callP50Ms);
      expect(rows[i]!.calls).toBeLessThan(rows[i - 1]!.calls);
    }
    // Overhead amortization is exact: 400/n + 60 input tokens per item.
    expect(rows[0]!.inputTokensPerItem).toBeCloseTo(460, 9);
    expect(rows[2]!.inputTokensPerItem).toBeCloseTo(400 / 16 + 60, 9);
  });

  it("reports what an item waits, not just what a call takes", async () => {
    const rows = await runBatchSizeSweep(SMALL_BATCHES);
    for (const row of rows) {
      // An item's wait is measured from job start, so it is never shorter
      // than the call carrying it and never longer than the whole job.
      expect(row.itemP50Ms).toBeGreaterThanOrEqual(row.callP50Ms);
      expect(row.itemP95Ms).toBeLessThanOrEqual(row.makespanMs);
    }
    // At batch 1 the gap is the whole point: a call takes ~100ms but an item
    // spends most of its wait queued behind other items in the client pool.
    expect(rows[0]!.itemP50Ms).toBeGreaterThan(4 * rows[0]!.callP50Ms);

    // Across the sweep the two columns point in opposite directions. Reading
    // the call column as an item's latency inverts the conclusion.
    const first = rows[0]!;
    const last = rows.at(-1)!;
    expect(last.callP50Ms).toBeGreaterThan(first.callP50Ms);
    expect(last.itemP50Ms).toBeLessThan(first.itemP50Ms);
    expect(last.makespanMs).toBeLessThan(first.makespanMs);
  });
});

describe("micro-batch sweep", () => {
  it("is deterministic run to run", async () => {
    expect(await runMicroBatchSweep(SMALL_MICRO)).toEqual(await runMicroBatchSweep(SMALL_MICRO));
  });

  it("fills batches and cuts cost as the wait budget grows, paying with latency", async () => {
    const rows = await runMicroBatchSweep(SMALL_MICRO);
    expect(rows[0]!.meanBatchSize).toBe(1);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.meanBatchSize).toBeGreaterThan(rows[i - 1]!.meanBatchSize);
      expect(rows[i]!.usdPer1kItems).toBeLessThan(rows[i - 1]!.usdPer1kItems);
      expect(rows[i]!.latencyP50Ms).toBeGreaterThan(rows[i - 1]!.latencyP50Ms);
    }
  });
});

describe("isolation sweep", () => {
  it("is deterministic run to run", async () => {
    expect(await runIsolationSweep()).toEqual(await runIsolationSweep());
  });

  it("pins the headline outcomes for a 32-item batch", async () => {
    const rows = await runIsolationSweep();
    const find = (k: number, strategy: string): IsolationRow => {
      const row = rows.find((r) => r.poisonedCount === k && r.strategy === strategy);
      if (!row) throw new Error(`missing row ${k}/${strategy}`);
      return row;
    };

    // One poisoned item: bisect needs 1 + 2·log2(32) = 11 calls vs 33 one-by-one.
    expect(find(1, "bisect").calls).toBe(11);
    expect(find(1, "one-by-one").calls).toBe(33);
    expect(find(1, "bisect").completed).toBe(31);
    expect(find(1, "one-by-one").completed).toBe(31);
    expect(find(1, "fail-all").lostHealthy).toBe(31);
    expect(find(1, "retry-whole").calls).toBe(4);
    expect(find(1, "retry-whole").completed).toBe(0);

    // Every strategy that recovers items identifies exactly the poison set.
    for (const [k] of [[1], [2], [4]]) {
      expect(find(k!, "bisect").identified).toBe(k);
      expect(find(k!, "one-by-one").identified).toBe(k);
      expect(find(k!, "bisect").lostHealthy).toBe(0);
    }

    // The crossover: at k=1 bisect is cheaper than one-by-one in both calls
    // and tokens, but at k=4 spread across the batch it costs MORE tokens,
    // because failing halves resend the same items again and again.
    expect(find(1, "bisect").inputTokens).toBeLessThan(find(1, "one-by-one").inputTokens);
    expect(find(4, "bisect").inputTokens).toBeGreaterThan(find(4, "one-by-one").inputTokens);
    expect(find(4, "bisect").calls).toBe(31);
  });

  it("keeps the configured poison sets sorted and in range", () => {
    for (const set of ISOLATION.poisonSets) {
      for (const id of set) {
        expect(id).toBeGreaterThanOrEqual(0);
        expect(id).toBeLessThan(ISOLATION.batchSize);
      }
    }
  });
});
