import { describe, expect, it } from "vitest";
import {
  countInRange,
  peakPerWindow,
  runOutageScenario,
  type OutageScenarioOptions,
  type OutageStrategySpec,
} from "../src/outage.js";

function makeOpts(overrides: Partial<OutageScenarioOptions> = {}): OutageScenarioOptions {
  return {
    clients: 2,
    requestsPerClient: 1,
    serverRatePerSec: 20,
    serverBurst: 20,
    latencyMsMin: 10,
    latencyMsMax: 10,
    outageMs: 500,
    advertiseOutageRetryAfter: true,
    hintJitterMs: 0,
    seed: 7,
    ...overrides,
  };
}

const RETRY_AFTER_COMPLIANT: OutageStrategySpec = {
  name: "compliant",
  retry: { policy: { kind: "fixed", delayMs: 0 }, maxRetries: 8, respectRetryAfter: true },
};

describe("countInRange", () => {
  it("counts half-open [start, end)", () => {
    expect(countInRange([0, 100, 499, 500, 700], 0, 500)).toBe(3);
    expect(countInRange([0, 100, 499, 500, 700], 500, Number.POSITIVE_INFINITY)).toBe(2);
  });

  it("returns 0 on empty arrivals", () => {
    expect(countInRange([], 0, 1000)).toBe(0);
  });
});

describe("peakPerWindow", () => {
  it("anchors bins at fromMs and ignores earlier arrivals", () => {
    // Anchored at 0, [950, 1049] splits across two 100ms bins; anchored at
    // 950 all three land in one window.
    const arrivals = [100, 950, 1000, 1049];
    expect(peakPerWindow(arrivals, 100, 0)).toBe(2);
    expect(peakPerWindow(arrivals, 100, 950)).toBe(3);
  });

  it("returns 0 on empty arrivals and rejects a non-positive window", () => {
    expect(peakPerWindow([], 100)).toBe(0);
    expect(() => peakPerWindow([1], 0)).toThrow(/windowMs/);
  });
});

describe("runOutageScenario", () => {
  it("validates counts and the outage duration", async () => {
    await expect(runOutageScenario(RETRY_AFTER_COMPLIANT, makeOpts({ clients: -1 }))).rejects.toThrow(
      /clients/,
    );
    await expect(
      runOutageScenario(RETRY_AFTER_COMPLIANT, makeOpts({ requestsPerClient: 1.5 })),
    ).rejects.toThrow(/requestsPerClient/);
    await expect(runOutageScenario(RETRY_AFTER_COMPLIANT, makeOpts({ outageMs: -1 }))).rejects.toThrow(
      /outageMs/,
    );
  });

  it("returns an all-zero result for zero clients", async () => {
    const r = await runOutageScenario(RETRY_AFTER_COMPLIANT, makeOpts({ clients: 0 }));
    expect(r.requests).toBe(0);
    expect(r.totalAttempts).toBe(0);
    expect(r.makespanMs).toBe(0);
    expect(r.peakAttemptsPerSec).toBe(0);
    expect(Number.isNaN(r.giveUpP50Ms)).toBe(true);
    expect(Number.isNaN(r.successP50Ms)).toBe(true);
  });

  it("recovers exactly at the hinted instant with a compliant client", async () => {
    // Attempt 1 at t=0 hits the outage and hears "503, retry in 500ms";
    // attempt 2 lands at t=500 against a healthy server with the burst
    // intact, so both clients succeed after 10ms of latency.
    const r = await runOutageScenario(RETRY_AFTER_COMPLIANT, makeOpts());
    expect(r.succeeded).toBe(2);
    expect(r.failed).toBe(0);
    expect(r.totalAttempts).toBe(4);
    expect(r.attemptsDuringOutage).toBe(2);
    expect(r.attemptsAfterRecovery).toBe(2);
    expect(r.count429).toBe(0);
    expect(r.makespanMs).toBe(510);
    expect(r.drainMs).toBe(10);
    expect(r.successP50Ms).toBe(510);
    expect(Number.isNaN(r.giveUpP50Ms)).toBe(true);
  });

  it("fails everyone whose cumulative backoff cannot outlive the outage", async () => {
    const guessing = (maxRetries: number): OutageStrategySpec => ({
      name: `exp-${maxRetries}`,
      retry: {
        policy: { kind: "exponential", baseMs: 100, capMs: 10_000 },
        maxRetries,
        respectRetryAfter: false,
      },
    });
    // 3 retries reach t=700 at best, inside the 5s outage: all fail, and
    // every attempt lands during the outage.
    const dead = await runOutageScenario(guessing(3), makeOpts({ outageMs: 5000 }));
    expect(dead.succeeded).toBe(0);
    expect(dead.totalAttempts).toBe(8);
    expect(dead.attemptsDuringOutage).toBe(8);
    expect(dead.giveUpP50Ms).toBe(700);
    // 8 retries put attempt 7 at t=6300, past the outage: everyone survives.
    const alive = await runOutageScenario(guessing(8), makeOpts({ outageMs: 5000 }));
    expect(alive.succeeded).toBe(2);
    expect(alive.makespanMs).toBe(6310);
  });

  it("burns the full per-request budget against a dead service", async () => {
    const spec: OutageStrategySpec = {
      name: "fixed",
      retry: { policy: { kind: "fixed", delayMs: 10 }, maxRetries: 2, respectRetryAfter: false },
    };
    const r = await runOutageScenario(
      spec,
      makeOpts({
        clients: 3,
        requestsPerClient: 2,
        outageMs: Number.POSITIVE_INFINITY,
        advertiseOutageRetryAfter: false,
      }),
    );
    expect(r.succeeded).toBe(0);
    expect(r.failed).toBe(6);
    // Every request pays 1 + maxRetries attempts; there is nothing to learn from.
    expect(r.totalAttempts).toBe(6 * 3);
    expect(r.attemptsDuringOutage).toBe(6 * 3);
    expect(r.attemptsAfterRecovery).toBe(0);
    expect(Number.isNaN(r.recoveryPeakPer100ms)).toBe(true);
    expect(Number.isNaN(r.drainMs)).toBe(true);
    // Outage rejections are instant, so a give-up costs exactly the two waits.
    expect(r.giveUpP50Ms).toBe(20);
    expect(r.giveUpP99Ms).toBe(20);
  });

  it("is deterministic with jittered hints and never recovers earlier than exact", async () => {
    const opts = makeOpts({ hintJitterMs: 1000, serverBurst: 1, seed: 11 });
    const a = await runOutageScenario(RETRY_AFTER_COMPLIANT, opts);
    const b = await runOutageScenario(RETRY_AFTER_COMPLIANT, opts);
    expect(a).toEqual(b);
    const exact = await runOutageScenario(
      RETRY_AFTER_COMPLIANT,
      makeOpts({ hintJitterMs: 0, serverBurst: 1, seed: 11 }),
    );
    // Jitter only adds to hints, so the jittered herd can never finish first.
    expect(a.makespanMs).toBeGreaterThanOrEqual(exact.makespanMs);
    expect(a.succeeded).toBe(2);
  });
});
