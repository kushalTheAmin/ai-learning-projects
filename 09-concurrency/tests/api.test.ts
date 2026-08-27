import { describe, expect, it } from "vitest";
import { VirtualClock } from "../../06-rate-limiting/src/clock.js";
import { createRng } from "../../05-token-streaming/src/rng.js";
import { ApiError, SimulatedApi, costUsd, makeItems } from "../src/api.js";

/** rng pinned to 0.5 makes the jitter factor exactly 1.0. */
const flatRng = () => 0.5;

describe("SimulatedApi", () => {
  it("rejects an empty batch without recording a call", async () => {
    const clock = new VirtualClock();
    const api = new SimulatedApi(clock, flatRng);
    await expect(api.call([])).rejects.toMatchObject({ kind: "empty" });
    expect(api.snapshot().calls).toBe(0);
  });

  it("rejects an oversize batch instantly", async () => {
    const clock = new VirtualClock();
    const api = new SimulatedApi(clock, flatRng, { maxItemsPerCall: 4 });
    await expect(api.call(makeItems(5))).rejects.toMatchObject({ kind: "oversize" });
    expect(api.snapshot().calls).toBe(0);
    expect(clock.now()).toBe(0);
  });

  it("charges base plus per-item latency", async () => {
    const clock = new VirtualClock();
    const api = new SimulatedApi(clock, flatRng);
    await clock.runUntil(api.call(makeItems(1)));
    expect(clock.now()).toBe(100);
    await clock.runUntil(api.call(makeItems(4)));
    expect(clock.now()).toBe(100 + 160);
  });

  it("keeps jittered latency inside the ±10% band", async () => {
    const clock = new VirtualClock();
    const api = new SimulatedApi(clock, createRng(7));
    for (let i = 0; i < 20; i++) {
      const before = clock.now();
      await clock.runUntil(api.call(makeItems(1)));
      const elapsed = clock.now() - before;
      expect(elapsed).toBeGreaterThanOrEqual(90);
      expect(elapsed).toBeLessThanOrEqual(110);
    }
  });

  it("accounts tokens as overhead per call plus per-item input and output", async () => {
    const clock = new VirtualClock();
    const api = new SimulatedApi(clock, flatRng);
    await clock.runUntil(api.call(makeItems(3)));
    const stats = api.snapshot();
    expect(stats.inputTokens).toBe(400 + 3 * 60);
    expect(stats.outputTokens).toBe(3 * 30);
    expect(stats.itemsCompleted).toBe(3);
    expect(api.costUsd()).toBeCloseTo((580 * 3 + 90 * 15) / 1_000_000, 12);
  });

  it("fails a call with any poisoned item after base latency, charging input only", async () => {
    const clock = new VirtualClock();
    const api = new SimulatedApi(clock, flatRng);
    const items = makeItems(4, [2]);
    await expect(clock.runUntil(api.call(items))).rejects.toMatchObject({ kind: "validation" });
    expect(clock.now()).toBe(80);
    const stats = api.snapshot();
    expect(stats.calls).toBe(1);
    expect(stats.failedCalls).toBe(1);
    expect(stats.inputTokens).toBe(400 + 4 * 60);
    expect(stats.outputTokens).toBe(0);
    expect(stats.itemsCompleted).toBe(0);
  });

  it("queues calls beyond maxConcurrent and records the wait", async () => {
    const clock = new VirtualClock();
    const api = new SimulatedApi(clock, flatRng, { maxConcurrent: 2 });
    const run = Promise.all(Array.from({ length: 4 }, () => api.call(makeItems(1))));
    await clock.runUntil(run);
    expect(clock.now()).toBe(200);
    expect(api.snapshot().queueWaitsMs).toEqual([0, 0, 100, 100]);
  });

  it("is a pure function of the seed", async () => {
    const runOnce = async () => {
      const clock = new VirtualClock();
      const api = new SimulatedApi(clock, createRng(99), { maxConcurrent: 3 });
      const run = Promise.all(
        Array.from({ length: 9 }, (_, i) => api.call(makeItems((i % 3) + 1))),
      );
      await clock.runUntil(run);
      return { at: clock.now(), stats: api.snapshot() };
    };
    expect(await runOnce()).toEqual(await runOnce());
  });
});

describe("costUsd", () => {
  it("prices input and output at their own rates", () => {
    expect(costUsd(1_000_000, 0, { inputPricePerMTok: 3, outputPricePerMTok: 15 })).toBe(3);
    expect(costUsd(0, 1_000_000, { inputPricePerMTok: 3, outputPricePerMTok: 15 })).toBe(15);
    expect(costUsd(0, 0, { inputPricePerMTok: 3, outputPricePerMTok: 15 })).toBe(0);
  });
});

describe("makeItems", () => {
  it("marks exactly the requested ids as poisoned", () => {
    const items = makeItems(5, [0, 4]);
    expect(items.map((i) => i.poisoned)).toEqual([true, false, false, false, true]);
    expect(items.map((i) => i.id)).toEqual([0, 1, 2, 3, 4]);
  });
});
