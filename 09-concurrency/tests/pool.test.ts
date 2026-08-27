import { describe, expect, it } from "vitest";
import { VirtualClock } from "../../06-rate-limiting/src/clock.js";
import { mapBounded, mapBoundedSettled } from "../src/pool.js";

describe("mapBoundedSettled", () => {
  it("returns an empty result for no items", async () => {
    const { results, stats } = await mapBoundedSettled([], 4, async (x: number) => x);
    expect(results).toEqual([]);
    expect(stats.concurrencyHighWater).toBe(0);
    expect(stats.started).toBe(0);
  });

  it("keeps results in input order even when later items finish first", async () => {
    const clock = new VirtualClock();
    const delays = [50, 10, 30, 1];
    const run = mapBoundedSettled(delays, 4, async (delayMs, index) => {
      await clock.sleep(delayMs);
      return index;
    });
    const { results } = await clock.runUntil(run);
    expect(results).toEqual([
      { status: "ok", value: 0 },
      { status: "ok", value: 1 },
      { status: "ok", value: 2 },
      { status: "ok", value: 3 },
    ]);
  });

  it("never exceeds the concurrency limit", async () => {
    const clock = new VirtualClock();
    let active = 0;
    let maxActive = 0;
    const run = mapBoundedSettled(Array.from({ length: 10 }, (_, i) => i), 3, async (i) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await clock.sleep(5 + i);
      active--;
      return i;
    });
    const { stats } = await clock.runUntil(run);
    expect(maxActive).toBe(3);
    expect(stats.concurrencyHighWater).toBe(3);
    expect(stats.started).toBe(10);
  });

  it("uses only as many slots as there are items", async () => {
    const clock = new VirtualClock();
    const run = mapBoundedSettled([1, 2], 16, async (x) => {
      await clock.sleep(1);
      return x;
    });
    const { stats } = await clock.runUntil(run);
    expect(stats.concurrencyHighWater).toBe(2);
  });

  it("records a per-item error without touching the other items", async () => {
    const { results } = await mapBoundedSettled([1, 2, 3], 2, async (x) => {
      if (x === 2) throw new Error("item 2 broke");
      return x * 10;
    });
    expect(results[0]).toEqual({ status: "ok", value: 10 });
    expect(results[1]?.status).toBe("error");
    expect((results[1] as { error: Error }).error.message).toBe("item 2 broke");
    expect(results[2]).toEqual({ status: "ok", value: 30 });
  });
});

describe("mapBounded (fail-fast)", () => {
  it("returns ordered results when everything succeeds", async () => {
    const clock = new VirtualClock();
    const run = mapBounded([30, 20, 10], 3, async (delayMs) => {
      await clock.sleep(delayMs);
      return delayMs * 2;
    });
    const { results } = await clock.runUntil(run);
    expect(results).toEqual([60, 40, 20]);
  });

  it("rethrows the first error and stops starting new items", async () => {
    const calls: number[] = [];
    const run = mapBounded([1, 2, 3, 4], 1, async (x) => {
      calls.push(x);
      if (x === 2) throw new Error("stop here");
      return x;
    });
    await expect(run).rejects.toThrow("stop here");
    expect(calls).toEqual([1, 2]);
  });

  it("lets in-flight items settle before rejecting", async () => {
    const clock = new VirtualClock();
    let slowFinished = false;
    const run = mapBounded([1, 2], 2, async (x) => {
      if (x === 1) throw new Error("fast failure");
      await clock.sleep(100);
      slowFinished = true;
      return x;
    });
    await expect(clock.runUntil(run)).rejects.toThrow("fast failure");
    expect(slowFinished).toBe(true);
  });
});
