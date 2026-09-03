import { describe, expect, it } from "vitest";
import { runStorm, summarize, type StormConfig, type StormPolicy } from "../src/storm.js";

const NO_RETRY: StormPolicy = {
  name: "no-retry",
  maxRetries: 0,
  backoff: { kind: "fixed", delayMs: 0 },
};

/** Server that is degraded for the whole run: 100ms base at 50x is 5000ms. */
const DEAD_SLOW = { startMs: 0, endMs: 1_000_000_000, factor: 50 };

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

describe("breaker wiring", () => {
  it("reports no breaker stats when the policy carries no breaker", async () => {
    const result = await runStorm(baseConfig());
    expect(result.breakerStats).toBeUndefined();
    expect(result.fastFailedTasks).toBe(0);
    expect(result.records.every((r) => !r.fastFailed)).toBe(true);
  });

  it("surfaces 06's option validation at construction", async () => {
    const cfg = baseConfig({
      policy: { ...NO_RETRY, breaker: { failureThreshold: 0, openMs: 1000 } },
    });
    await expect(runStorm(cfg)).rejects.toThrow(/failureThreshold/);
  });

  it("a breaker that never trips leaves every record identical to the breakerless run", async () => {
    const shared: Partial<StormConfig> = {
      arrivalGapMs: 100,
      arrivalWindowMs: 3000,
      timeoutMs: 300,
      api: {
        baseLatencyMs: 100,
        perItemLatencyMs: 0,
        latencyJitter: 0.1,
        maxConcurrent: 4,
        slowdown: { startMs: 500, endMs: 1500, factor: 5 },
      },
    };
    const retrying: StormPolicy = {
      name: "retry",
      maxRetries: 4,
      backoff: { kind: "full-jitter", baseMs: 100, capMs: 800 },
    };
    const bare = await runStorm(baseConfig({ ...shared, policy: retrying }));
    const gated = await runStorm(
      baseConfig({
        ...shared,
        policy: { ...retrying, breaker: { failureThreshold: 1_000_000, openMs: 5000 } },
      }),
    );
    expect(gated.records).toEqual(bare.records);
    expect(gated.attemptsStarted).toBe(bare.attemptsStarted);
    expect(gated.breakerStats).toEqual({ trips: 0, probes: 0, probeFailures: 0, rejections: 0 });
    expect(gated.fastFailedTasks).toBe(0);
  });
});

describe("trip and shed", () => {
  it("trips after threshold consecutive timeouts and sheds later arrivals with zero wire attempts", async () => {
    // Every attempt times out at start+1000ms; timeouts settle in arrival
    // order, so failures 1..3 land at 1000/1100/1200ms and the trip beats the
    // 1200ms arrival to the clock instant (its timer was scheduled earlier).
    const result = await runStorm(
      baseConfig({
        arrivalGapMs: 100,
        arrivalWindowMs: 2000,
        timeoutMs: 1000,
        api: {
          baseLatencyMs: 100,
          perItemLatencyMs: 0,
          latencyJitter: 0,
          maxConcurrent: 4,
          slowdown: DEAD_SLOW,
        },
        policy: { ...NO_RETRY, breaker: { failureThreshold: 3, openMs: 60_000 } },
      }),
    );
    expect(result.records).toHaveLength(20);
    expect(result.attemptsStarted).toBe(12);
    expect(result.fastFailedTasks).toBe(8);
    expect(result.breakerStats).toMatchObject({ trips: 1, probes: 0, probeFailures: 0 });
    expect(result.breakerStats!.rejections).toBe(result.fastFailedTasks);
    for (const record of result.records) {
      if (record.arrivedMs >= 1200) {
        expect(record).toMatchObject({ ok: false, attempts: 0, fastFailed: true });
        expect(record.settledMs).toBe(record.arrivedMs);
      } else {
        expect(record.fastFailed).toBe(false);
        expect(record.attempts).toBe(1);
      }
    }
  });

  it("admits exactly one half-open probe per cooldown and a probe timeout restarts the cooldown", async () => {
    // Threshold 1, cooldown 3000, arrivals every 700ms for 10s against a
    // permanently degraded server. Task 0 trips at 1000ms; the 700ms task was
    // already admitted; probes ride the arrivals at 4200 and 8400.
    const result = await runStorm(
      baseConfig({
        arrivalGapMs: 700,
        arrivalWindowMs: 10_000,
        timeoutMs: 1000,
        api: {
          baseLatencyMs: 100,
          perItemLatencyMs: 0,
          latencyJitter: 0,
          maxConcurrent: 4,
          slowdown: DEAD_SLOW,
        },
        policy: { ...NO_RETRY, breaker: { failureThreshold: 1, openMs: 3000 } },
      }),
    );
    expect(result.records).toHaveLength(15);
    expect(result.attemptsStarted).toBe(4); // tasks at 0 and 700, probes at 4200 and 8400
    expect(result.breakerStats).toMatchObject({ trips: 1, probes: 2, probeFailures: 2 });
    expect(result.fastFailedTasks).toBe(11);
    expect(result.breakerStats!.rejections).toBe(11);
    const probeArrivals = result.records
      .filter((r) => !r.fastFailed && r.arrivedMs >= 1000)
      .map((r) => r.arrivedMs);
    expect(probeArrivals).toEqual([4200, 8400]);
  });

  it("closes on a successful probe and the orphaned pre-trip attempt never settles the gate", async () => {
    // Degraded only until 4000ms. Task 0 times out at 1000 and trips the
    // breaker (threshold 1, cooldown 5000); its orphan completes server-side
    // at 5000 while the breaker is open and must not close it. The 6000ms
    // arrival is the probe, meets a healthy server, and closes the breaker
    // for everything after it.
    const result = await runStorm(
      baseConfig({
        arrivalGapMs: 1000,
        arrivalWindowMs: 12_000,
        timeoutMs: 1000,
        api: {
          baseLatencyMs: 100,
          perItemLatencyMs: 0,
          latencyJitter: 0,
          maxConcurrent: 4,
          slowdown: { startMs: 0, endMs: 4000, factor: 50 },
        },
        policy: { ...NO_RETRY, breaker: { failureThreshold: 1, openMs: 5000 } },
      }),
    );
    expect(result.records).toHaveLength(12);
    expect(result.wastedCompletions).toBe(1);
    expect(result.breakerStats).toMatchObject({ trips: 1, probes: 1, probeFailures: 0 });
    const byArrival = new Map(result.records.map((r) => [r.arrivedMs, r]));
    for (const arrivedMs of [1000, 2000, 3000, 4000, 5000]) {
      expect(byArrival.get(arrivedMs)).toMatchObject({ ok: false, fastFailed: true, attempts: 0 });
    }
    expect(byArrival.get(6000)).toMatchObject({ ok: true, fastFailed: false, settledMs: 6100 });
    for (const arrivedMs of [7000, 8000, 9000, 10_000, 11_000]) {
      expect(byArrival.get(arrivedMs)).toMatchObject({ ok: true, attempts: 1 });
    }
    const summary = summarize(result);
    expect(summary.fastFailedTasks).toBe(5);
    expect(summary.fastFailPct).toBeCloseTo((5 / 12) * 100, 10);
    expect(summary.breakerStats).toEqual(result.breakerStats);
  });
});

describe("breaker beside the retry budget", () => {
  it("a budget-granted retry can still die at the gate, and the gate spends no budget", async () => {
    // Task 0's first attempt times out at 500ms and trips the breaker
    // (threshold 1). The budget grants its retry, but the gate is open by the
    // time the zero-delay backoff comes back around, so the task ends
    // fast-failed with the token spent and no denial recorded.
    const result = await runStorm(
      baseConfig({
        arrivalGapMs: 600,
        arrivalWindowMs: 2400,
        timeoutMs: 500,
        api: {
          baseLatencyMs: 100,
          perItemLatencyMs: 0,
          latencyJitter: 0,
          maxConcurrent: 4,
          slowdown: DEAD_SLOW,
        },
        policy: {
          name: "budget+breaker",
          maxRetries: 4,
          backoff: { kind: "fixed", delayMs: 0 },
          budget: { ratio: 0.1, cap: 10 },
          breaker: { failureThreshold: 1, openMs: 60_000 },
        },
      }),
    );
    expect(result.records).toHaveLength(4);
    expect(result.records[0]).toMatchObject({
      ok: false,
      attempts: 1,
      fastFailed: true,
      budgetDenied: false,
    });
    expect(result.retriesDenied).toBe(0);
    expect(result.attemptsStarted).toBe(1);
    for (const record of result.records.slice(1)) {
      expect(record).toMatchObject({ ok: false, attempts: 0, fastFailed: true });
    }
  });

  it("is deterministic run to run", async () => {
    const cfg = (): StormConfig =>
      baseConfig({
        arrivalGapMs: 100,
        arrivalWindowMs: 4000,
        timeoutMs: 800,
        api: {
          baseLatencyMs: 100,
          perItemLatencyMs: 0,
          latencyJitter: 0.1,
          maxConcurrent: 4,
          slowdown: { startMs: 500, endMs: 2500, factor: 8 },
        },
        policy: {
          name: "brk",
          maxRetries: 4,
          backoff: { kind: "full-jitter", baseMs: 200, capMs: 1600 },
          breaker: { failureThreshold: 5, openMs: 2000 },
        },
      });
    const [a, b] = [await runStorm(cfg()), await runStorm(cfg())];
    expect(JSON.stringify(summarize(a))).toBe(JSON.stringify(summarize(b)));
    expect(a.records).toEqual(b.records);
  });
});
