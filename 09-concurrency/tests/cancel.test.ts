import { describe, expect, it } from "vitest";
import { VirtualClock } from "../../06-rate-limiting/src/clock.js";
import { AcquireCancelledError, Semaphore } from "../src/semaphore.js";
import { ApiError, SimulatedApi, makeItems } from "../src/api.js";
import { runStorm, summarize, type StormConfig, type StormPolicy } from "../src/storm.js";

const flatRng = () => 0.5;

const NO_RETRY: StormPolicy = { name: "no-retry", maxRetries: 0, backoff: { kind: "fixed", delayMs: 0 } };
const ONE_RETRY: StormPolicy = { name: "one-retry", maxRetries: 1, backoff: { kind: "fixed", delayMs: 0 } };

function baseConfig(overrides: Partial<StormConfig> = {}): StormConfig {
  return {
    seed: 42,
    arrivalGapMs: 1000,
    arrivalWindowMs: 1000,
    timeoutMs: 1000,
    api: { baseLatencyMs: 100, perItemLatencyMs: 0, latencyJitter: 0, maxConcurrent: 4 },
    policy: NO_RETRY,
    ...overrides,
  };
}

describe("Semaphore.acquire with an AbortSignal", () => {
  it("rejects a waiter whose signal aborts and removes it from the queue", async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    const controller = new AbortController();
    const waiting = sem.acquire(controller.signal);
    expect(sem.waiting()).toBe(1);
    controller.abort();
    await expect(waiting).rejects.toBeInstanceOf(AcquireCancelledError);
    expect(sem.waiting()).toBe(0);
    expect(sem.cancelledWaits()).toBe(1);
    release();
    expect(sem.inUse()).toBe(0);
  });

  it("skips a cancelled waiter and serves the next one in FIFO order", async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    const controller = new AbortController();
    const cancelled = sem.acquire(controller.signal);
    const order: string[] = [];
    const survivor = sem.acquire().then((r) => {
      order.push("survivor");
      return r;
    });
    controller.abort();
    await expect(cancelled).rejects.toBeInstanceOf(AcquireCancelledError);
    release();
    const survivorRelease = await survivor;
    expect(order).toEqual(["survivor"]);
    expect(sem.inUse()).toBe(1);
    survivorRelease();
    expect(sem.inUse()).toBe(0);
  });

  it("rejects immediately on an already-aborted signal without queueing", async () => {
    const sem = new Semaphore(1);
    const controller = new AbortController();
    controller.abort();
    await expect(sem.acquire(controller.signal)).rejects.toBeInstanceOf(AcquireCancelledError);
    expect(sem.inUse()).toBe(0);
    expect(sem.waiting()).toBe(0);
    expect(sem.cancelledWaits()).toBe(1);
  });

  it("ignores an abort once the permit is granted immediately", async () => {
    const sem = new Semaphore(1);
    const controller = new AbortController();
    const release = await sem.acquire(controller.signal);
    controller.abort();
    expect(sem.inUse()).toBe(1);
    release();
    expect(sem.inUse()).toBe(0);
  });

  it("ignores an abort arriving after a queued waiter was served", async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    const controller = new AbortController();
    const waiting = sem.acquire(controller.signal);
    release();
    const waiterRelease = await waiting;
    controller.abort();
    expect(sem.inUse()).toBe(1);
    expect(sem.cancelledWaits()).toBe(0);
    waiterRelease();
    expect(sem.inUse()).toBe(0);
  });

  it("keeps permit accounting intact across a cancellation under load", async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    const controllers = [new AbortController(), new AbortController()];
    const first = sem.acquire(controllers[0]!.signal);
    const second = sem.acquire(controllers[1]!.signal);
    expect(sem.maxQueue()).toBe(2);
    controllers[0]!.abort();
    await expect(first).rejects.toBeInstanceOf(AcquireCancelledError);
    release();
    const secondRelease = await second;
    expect(sem.inUse()).toBe(1);
    secondRelease();
    expect(sem.inUse()).toBe(0);
  });
});

describe("SimulatedApi cancellation", () => {
  it("a call cancelled while queued is never admitted, served, or charged", async () => {
    const clock = new VirtualClock();
    const api = new SimulatedApi(clock, flatRng, {
      baseLatencyMs: 100,
      perItemLatencyMs: 0,
      latencyJitter: 0,
      maxConcurrent: 1,
    });
    const controller = new AbortController();
    const driver = (async () => {
      const inService = api.call(makeItems(1));
      const queued = api.call(makeItems(1), controller.signal);
      await clock.sleep(50);
      controller.abort();
      await expect(queued).rejects.toMatchObject({ kind: "cancelled" });
      await inService;
    })();
    await clock.runUntil(driver);
    const stats = api.snapshot();
    expect(stats.calls).toBe(1);
    expect(stats.itemsCompleted).toBe(1);
    expect(stats.cancelledInQueue).toBe(1);
    expect(stats.inputTokens).toBe(460);
    expect(stats.maxQueueDepth).toBe(1);
    expect(clock.now()).toBe(100);
  });

  it("an already-aborted signal cancels before any time passes", async () => {
    const clock = new VirtualClock();
    const api = new SimulatedApi(clock, flatRng, { maxConcurrent: 1 });
    const controller = new AbortController();
    controller.abort();
    await expect(clock.runUntil(api.call(makeItems(1), controller.signal))).rejects.toMatchObject({
      kind: "cancelled",
    });
    expect(clock.now()).toBe(0);
    expect(api.snapshot().cancelledInQueue).toBe(1);
  });

  it("an abort after admission does not stop service", async () => {
    const clock = new VirtualClock();
    const api = new SimulatedApi(clock, flatRng, {
      baseLatencyMs: 100,
      perItemLatencyMs: 0,
      latencyJitter: 0,
      maxConcurrent: 1,
    });
    const controller = new AbortController();
    const driver = (async () => {
      const call = api.call(makeItems(1), controller.signal);
      await clock.sleep(50);
      controller.abort();
      return call;
    })();
    const results = await clock.runUntil(driver);
    expect(results).toHaveLength(1);
    expect(clock.now()).toBe(100);
    expect(api.snapshot().cancelledInQueue).toBe(0);
  });

  it("the cancelled error is an ApiError with kind cancelled", async () => {
    const clock = new VirtualClock();
    const api = new SimulatedApi(clock, flatRng, { maxConcurrent: 1 });
    const controller = new AbortController();
    controller.abort();
    const err = await clock.runUntil(api.call(makeItems(1), controller.signal)).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe("cancelled");
  });
});

describe("runStorm cancelOnTimeout", () => {
  const STARVE_OVERRIDES: Partial<StormConfig> = {
    timeoutMs: 400,
    policy: ONE_RETRY,
    api: {
      baseLatencyMs: 100,
      perItemLatencyMs: 0,
      latencyJitter: 0,
      maxConcurrent: 1,
      slowdown: { startMs: 0, endMs: 150, factor: 10 },
    },
  };

  it("cancels the starved queued retry instead of serving it to nobody", async () => {
    // Abandon mode (the storm study): the orphaned first attempt holds the
    // only slot to t=1000, the retry queues behind it, times out at t=800,
    // and is served anyway at t=1100: two wasted completions. Cancel mode:
    // the in-service orphan is unkillable and still completes at t=1000, but
    // the retry's abort dequeues it at t=800, so the server never serves it.
    const result = await runStorm(baseConfig({ ...STARVE_OVERRIDES, cancelOnTimeout: true }));
    const record = result.records[0]!;
    expect(record).toMatchObject({ ok: false, attempts: 2 });
    expect(record.settledMs).toBe(800);
    expect(result.attemptsAbandoned).toBe(2);
    expect(result.wastedCompletions).toBe(1);
    expect(result.attemptsCancelled).toBe(1);
    expect(result.drainedAtMs).toBe(1000);
    expect(result.apiStats.itemsCompleted).toBe(1);
    expect(result.apiStats.cancelledInQueue).toBe(1);
  });

  it("abandon mode still serves both attempts as wasted work", async () => {
    const result = await runStorm(baseConfig({ ...STARVE_OVERRIDES, cancelOnTimeout: false }));
    expect(result.wastedCompletions).toBe(2);
    expect(result.attemptsCancelled).toBe(0);
    expect(result.drainedAtMs).toBe(1100);
    expect(result.apiStats.itemsCompleted).toBe(2);
  });

  it("cannot cancel an attempt already in service", async () => {
    // One task, one slot, service 500ms against a 200ms timeout: the attempt
    // is in service when the timeout fires, so cancel mode changes nothing.
    const result = await runStorm(
      baseConfig({
        timeoutMs: 200,
        cancelOnTimeout: true,
        api: { baseLatencyMs: 500, perItemLatencyMs: 0, latencyJitter: 0, maxConcurrent: 4 },
      }),
    );
    expect(result.attemptsAbandoned).toBe(1);
    expect(result.attemptsCancelled).toBe(0);
    expect(result.wastedCompletions).toBe(1);
    expect(result.drainedAtMs).toBe(500);
  });

  it("no timeout, no cancellation: healthy runs are identical in both modes", async () => {
    const abandon = await runStorm(baseConfig({ cancelOnTimeout: false }));
    const cancel = await runStorm(baseConfig({ cancelOnTimeout: true }));
    expect(summarize(cancel)).toEqual(summarize(abandon));
    expect(cancel.attemptsCancelled).toBe(0);
  });

  it("omitting the flag behaves exactly like cancelOnTimeout false", async () => {
    const implicit = await runStorm(baseConfig(STARVE_OVERRIDES));
    const explicit = await runStorm(baseConfig({ ...STARVE_OVERRIDES, cancelOnTimeout: false }));
    expect(summarize(implicit)).toEqual(summarize(explicit));
  });

  it("is deterministic: the same cancel config yields the identical summary twice", async () => {
    const cfg = baseConfig({
      arrivalGapMs: 40,
      arrivalWindowMs: 4000,
      timeoutMs: 300,
      cancelOnTimeout: true,
      policy: { name: "jitter-x2", maxRetries: 2, backoff: { kind: "full-jitter", baseMs: 200, capMs: 2000 } },
      api: {
        baseLatencyMs: 100,
        perItemLatencyMs: 0,
        latencyJitter: 0.1,
        maxConcurrent: 2,
        slowdown: { startMs: 500, endMs: 2000, factor: 6 },
      },
    });
    const first = summarize(await runStorm(cfg));
    const second = summarize(await runStorm(cfg));
    expect(second).toEqual(first);
    expect(first.attemptsCancelled + first.wastedCompletions).toBeLessThanOrEqual(
      (await runStorm(cfg)).attemptsAbandoned,
    );
  });

  it("summarize reports cancelled share and queue depth", async () => {
    const result = await runStorm(baseConfig({ ...STARVE_OVERRIDES, cancelOnTimeout: true }));
    const summary = summarize(result);
    expect(summary.attemptsCancelled).toBe(1);
    expect(summary.cancelledPct).toBe(50);
    expect(summary.maxQueueDepth).toBe(1);
  });
});
