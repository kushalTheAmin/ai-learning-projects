import { describe, expect, it } from "vitest";
import { VirtualClock } from "../../06-rate-limiting/src/clock.js";
import { SimulatedApi, makeItems } from "../src/api.js";
import {
  RetryBudget,
  recoveryLagMs,
  runStorm,
  summarize,
  timeline,
  type StormConfig,
  type StormPolicy,
} from "../src/storm.js";

/** rng pinned to 0.5 makes the jitter factor exactly 1.0. */
const flatRng = () => 0.5;

const NO_RETRY: StormPolicy = { name: "no-retry", maxRetries: 0, backoff: { kind: "fixed", delayMs: 0 } };

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

describe("SimulatedApi slowdown", () => {
  it("multiplies service time for calls starting inside the window only", async () => {
    const clock = new VirtualClock();
    const api = new SimulatedApi(clock, flatRng, {
      baseLatencyMs: 100,
      perItemLatencyMs: 0,
      slowdown: { startMs: 100, endMs: 300, factor: 5 },
    });
    await clock.runUntil(api.call(makeItems(1))); // starts at 0, outside
    expect(clock.now()).toBe(100);
    await clock.runUntil(api.call(makeItems(1))); // starts at 100, inside
    expect(clock.now()).toBe(600);
    await clock.runUntil(api.call(makeItems(1))); // starts at 600, past the window
    expect(clock.now()).toBe(700);
  });

  it("slows the failure path by the same factor", async () => {
    const clock = new VirtualClock();
    const api = new SimulatedApi(clock, flatRng, {
      baseLatencyMs: 100,
      slowdown: { startMs: 0, endMs: 1000, factor: 3 },
    });
    await expect(clock.runUntil(api.call(makeItems(1, [0])))).rejects.toMatchObject({
      kind: "validation",
    });
    expect(clock.now()).toBe(300);
  });

  it("rejects malformed slowdown windows and factors", () => {
    const clock = new VirtualClock();
    expect(
      () => new SimulatedApi(clock, flatRng, { slowdown: { startMs: 500, endMs: 100, factor: 2 } }),
    ).toThrow(/slowdown window/);
    expect(
      () => new SimulatedApi(clock, flatRng, { slowdown: { startMs: 0, endMs: 100, factor: 0.5 } }),
    ).toThrow(/slowdown factor/);
    expect(
      () => new SimulatedApi(clock, flatRng, { slowdown: { startMs: -1, endMs: 100, factor: 2 } }),
    ).toThrow(/slowdown window/);
  });
});

describe("RetryBudget", () => {
  it("starts at the cap and denies once the balance drops below one", () => {
    const budget = new RetryBudget({ ratio: 0.1, cap: 2 });
    expect(budget.trySpend()).toBe(true);
    expect(budget.trySpend()).toBe(true);
    expect(budget.trySpend()).toBe(false);
    expect(budget.deniedCount()).toBe(1);
  });

  it("earns ratio per first attempt and never exceeds the cap", () => {
    const budget = new RetryBudget({ ratio: 0.5, cap: 1 });
    budget.earn();
    expect(budget.balanceNow()).toBe(1);
    expect(budget.trySpend()).toBe(true);
    budget.earn();
    expect(budget.balanceNow()).toBe(0.5);
    expect(budget.trySpend()).toBe(false);
    budget.earn();
    expect(budget.trySpend()).toBe(true);
  });

  it("rejects a ratio outside [0, 1] and a cap below 1", () => {
    expect(() => new RetryBudget({ ratio: 1.5, cap: 5 })).toThrow(/ratio/);
    expect(() => new RetryBudget({ ratio: 0.1, cap: 0.5 })).toThrow(/cap/);
  });
});

describe("runStorm", () => {
  it("validates its numeric inputs", async () => {
    await expect(runStorm(baseConfig({ arrivalGapMs: 0 }))).rejects.toThrow(/arrivalGapMs/);
    await expect(runStorm(baseConfig({ arrivalWindowMs: -1 }))).rejects.toThrow(/arrivalWindowMs/);
    await expect(runStorm(baseConfig({ timeoutMs: 0 }))).rejects.toThrow(/timeoutMs/);
    await expect(runStorm(baseConfig({ flakeRate: 1.5 }))).rejects.toThrow(/flakeRate/);
    await expect(
      runStorm(baseConfig({ policy: { ...NO_RETRY, maxRetries: -1 } })),
    ).rejects.toThrow(/maxRetries/);
  });

  it("handles an empty arrival window", async () => {
    const result = await runStorm(baseConfig({ arrivalWindowMs: 0 }));
    expect(result.records).toHaveLength(0);
    expect(result.attemptsStarted).toBe(0);
    const summary = summarize(result);
    expect(summary.successPct).toBe(100);
    expect(summary.p50LatencyMs).toBeUndefined();
    expect(summary.usdPer1kDone).toBeUndefined();
  });

  it("completes a single healthy task in one attempt with nothing wasted", async () => {
    const result = await runStorm(baseConfig());
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({ id: 0, arrivedMs: 0, attempts: 1, ok: true });
    expect(result.records[0]!.latencyMs).toBe(100);
    expect(result.attemptsStarted).toBe(1);
    expect(result.attemptsAbandoned).toBe(0);
    expect(result.wastedCompletions).toBe(0);
    expect(summarize(result).amplification).toBe(1);
  });

  it("abandons at the timeout without cancelling: the orphan still drains as wasted work", async () => {
    const result = await runStorm(
      baseConfig({
        timeoutMs: 200,
        api: { baseLatencyMs: 500, perItemLatencyMs: 0, latencyJitter: 0, maxConcurrent: 4 },
      }),
    );
    const record = result.records[0]!;
    expect(record.ok).toBe(false);
    expect(record.attempts).toBe(1);
    expect(record.settledMs).toBe(200);
    expect(result.attemptsAbandoned).toBe(1);
    expect(result.wastedCompletions).toBe(1);
    expect(result.drainedAtMs).toBe(500);
    expect(result.apiStats.itemsCompleted).toBe(1);
  });

  it("a retry can succeed while the abandoned first attempt still occupies a slot", async () => {
    // Attempt 1 starts service at t=0 inside a 10x slowdown (1000ms) and is
    // abandoned at 400ms; the retry starts at 400ms outside the window and
    // needs a second server slot to finish at 500ms.
    const result = await runStorm(
      baseConfig({
        timeoutMs: 400,
        policy: { name: "one-retry", maxRetries: 1, backoff: { kind: "fixed", delayMs: 0 } },
        api: {
          baseLatencyMs: 100,
          perItemLatencyMs: 0,
          latencyJitter: 0,
          maxConcurrent: 2,
          slowdown: { startMs: 0, endMs: 150, factor: 10 },
        },
      }),
    );
    const record = result.records[0]!;
    expect(record).toMatchObject({ ok: true, attempts: 2 });
    expect(record.settledMs).toBe(500);
    expect(record.latencyMs).toBe(500);
    expect(result.attemptsAbandoned).toBe(1);
    expect(result.wastedCompletions).toBe(1);
    expect(result.drainedAtMs).toBe(1000);
  });

  it("with one server slot the orphan starves its own retry past the timeout", async () => {
    // Same shape but maxConcurrent 1: the retry queues behind the orphan
    // holding the only slot until t=1000, so its own 400ms timeout fires at
    // t=800 while it is still waiting. Both attempts end up wasted work.
    const result = await runStorm(
      baseConfig({
        timeoutMs: 400,
        policy: { name: "one-retry", maxRetries: 1, backoff: { kind: "fixed", delayMs: 0 } },
        api: {
          baseLatencyMs: 100,
          perItemLatencyMs: 0,
          latencyJitter: 0,
          maxConcurrent: 1,
          slowdown: { startMs: 0, endMs: 150, factor: 10 },
        },
      }),
    );
    const record = result.records[0]!;
    expect(record).toMatchObject({ ok: false, attempts: 2 });
    expect(record.settledMs).toBe(800);
    expect(result.attemptsAbandoned).toBe(2);
    expect(result.wastedCompletions).toBe(2);
    expect(result.drainedAtMs).toBe(1100);
  });

  it("spends the shared budget across tasks and marks budget-denied failures", async () => {
    // Every attempt times out (service 500ms, timeout 100ms, plenty of
    // slots). ratio 0 and cap 1 leave exactly one retry for the whole run:
    // task 0 spends it, then both tasks are denied on their next ask.
    const result = await runStorm(
      baseConfig({
        arrivalGapMs: 10,
        arrivalWindowMs: 20,
        timeoutMs: 100,
        policy: {
          name: "budgeted",
          maxRetries: 3,
          backoff: { kind: "fixed", delayMs: 0 },
          budget: { ratio: 0, cap: 1 },
        },
        api: { baseLatencyMs: 500, perItemLatencyMs: 0, latencyJitter: 0, maxConcurrent: 8 },
      }),
    );
    expect(result.records).toHaveLength(2);
    const [first, second] = result.records;
    expect(first).toMatchObject({ ok: false, attempts: 2, budgetDenied: true });
    expect(second).toMatchObject({ ok: false, attempts: 1, budgetDenied: true });
    expect(result.retriesDenied).toBe(2);
    expect(result.attemptsStarted).toBe(3);
  });

  it("exhausting maxRetries is not a budget denial", async () => {
    const result = await runStorm(
      baseConfig({
        timeoutMs: 100,
        policy: { name: "two-tries", maxRetries: 1, backoff: { kind: "fixed", delayMs: 0 } },
        api: { baseLatencyMs: 500, perItemLatencyMs: 0, latencyJitter: 0, maxConcurrent: 8 },
      }),
    );
    expect(result.records[0]).toMatchObject({ ok: false, attempts: 2, budgetDenied: false });
    expect(result.retriesDenied).toBe(0);
  });

  it("retries rescue per-attempt flake", async () => {
    const cfg = baseConfig({
      arrivalGapMs: 50,
      arrivalWindowMs: 5000,
      flakeRate: 0.3,
      api: { baseLatencyMs: 20, perItemLatencyMs: 0, latencyJitter: 0, maxConcurrent: 8 },
    });
    const withoutRetry = summarize(await runStorm(cfg));
    const withRetry = summarize(
      await runStorm({
        ...cfg,
        policy: { name: "retry", maxRetries: 4, backoff: { kind: "fixed", delayMs: 10 } },
      }),
    );
    expect(withoutRetry.successPct).toBeLessThan(85);
    expect(withoutRetry.successPct).toBeGreaterThan(50);
    expect(withRetry.successPct).toBeGreaterThan(95);
    expect(withRetry.amplification).toBeGreaterThan(1.2);
  });

  it("is deterministic: the same config yields the identical summary twice", async () => {
    const cfg = baseConfig({
      arrivalGapMs: 40,
      arrivalWindowMs: 8000,
      flakeRate: 0.1,
      policy: { name: "jitter", maxRetries: 3, backoff: { kind: "full-jitter", baseMs: 100, capMs: 1000 } },
      api: {
        baseLatencyMs: 100,
        perItemLatencyMs: 0,
        latencyJitter: 0.1,
        maxConcurrent: 4,
        slowdown: { startMs: 2000, endMs: 4000, factor: 5 },
      },
    });
    const first = summarize(await runStorm(cfg));
    const second = summarize(await runStorm(cfg));
    expect(second).toEqual(first);
  });
});

describe("convergence vs storm", () => {
  // A scaled-down pulse: capacity 20/s, arrivals 12.5/s, a 6s window of 5x
  // slowdown inside 30s of arrivals. Unbudgeted retries multiply the offered
  // load past capacity permanently; no-retry and budgeted retries drain.
  const pulse = (policy: StormPolicy): StormConfig =>
    baseConfig({
      arrivalGapMs: 80,
      arrivalWindowMs: 30_000,
      timeoutMs: 1000,
      policy,
      api: {
        baseLatencyMs: 100,
        perItemLatencyMs: 0,
        latencyJitter: 0.1,
        maxConcurrent: 2,
        slowdown: { startMs: 8000, endMs: 14_000, factor: 5 },
      },
    });

  it("no-retry converges: failures stop soon after the dip ends", async () => {
    const result = await runStorm(pulse(NO_RETRY));
    const lag = recoveryLagMs(result, 14_000, 30_000);
    expect(lag).not.toBeUndefined();
    expect(lag!).toBeLessThan(12_000);
    const summary = summarize(result);
    expect(summary.amplification).toBe(1);
    expect(summary.successPct).toBeGreaterThan(50);
  });

  it("unbudgeted immediate retries storm: still failing when arrivals stop", async () => {
    const result = await runStorm(
      pulse({ name: "immediate", maxRetries: 4, backoff: { kind: "fixed", delayMs: 0 } }),
    );
    expect(recoveryLagMs(result, 14_000, 30_000)).toBeUndefined();
    const summary = summarize(result);
    expect(summary.amplification).toBeGreaterThan(3);
    expect(summary.wastedPct).toBeGreaterThan(80);
    // The server keeps serving abandoned attempts long after arrivals end.
    expect(result.drainedAtMs).toBeGreaterThan(40_000);
  });

  it("the same retries under a 10% budget converge again", async () => {
    const result = await runStorm(
      pulse({
        name: "budgeted",
        maxRetries: 4,
        backoff: { kind: "fixed", delayMs: 0 },
        budget: { ratio: 0.1, cap: 10 },
      }),
    );
    const lag = recoveryLagMs(result, 14_000, 30_000);
    expect(lag).not.toBeUndefined();
    const summary = summarize(result);
    expect(summary.amplification).toBeLessThan(1.5);
    expect(summary.retriesDenied).toBeGreaterThan(0);
  });
});

describe("summaries", () => {
  it("recoveryLagMs distinguishes clean runs, late failures, and never", async () => {
    const clean = await runStorm(baseConfig());
    expect(recoveryLagMs(clean, 0, 1000)).toBe(0);
    const failing = await runStorm(
      baseConfig({
        timeoutMs: 100,
        api: { baseLatencyMs: 500, perItemLatencyMs: 0, latencyJitter: 0, maxConcurrent: 4 },
      }),
    );
    // A guard spanning the whole window puts the arrival-0 failure inside it.
    expect(recoveryLagMs(failing, 0, 1000, 1000)).toBeUndefined();
    // With a smaller guard the same failure reads as lag 0 from dip end 0.
    expect(recoveryLagMs(failing, 0, 1000, 500)).toBe(0);
  });

  it("timeline bins outcomes by arrival and reports per-bin means", async () => {
    const result = await runStorm(
      baseConfig({
        arrivalGapMs: 100,
        arrivalWindowMs: 400,
        api: { baseLatencyMs: 50, perItemLatencyMs: 0, latencyJitter: 0, maxConcurrent: 4 },
      }),
    );
    const bins = timeline(result.records, 200, 400);
    expect(bins).toHaveLength(2);
    expect(bins[0]).toMatchObject({ startMs: 0, arrivals: 2, succeededPct: 100, meanAttempts: 1 });
    expect(bins[1]).toMatchObject({ startMs: 200, arrivals: 2, succeededPct: 100 });
    expect(bins[0]!.meanLatencyMs).toBe(50);
    expect(() => timeline(result.records, 0, 400)).toThrow(/binMs/);
  });
});
