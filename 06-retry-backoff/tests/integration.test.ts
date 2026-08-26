import { describe, expect, it } from "vitest";
import {
  exponential,
  exponentialFullJitter,
  fixedDelay,
  immediate,
  retryAfterExact,
  retryAfterJitter,
} from "../src/policies.js";
import { runScenario, type Scenario } from "../src/scenario.js";

const HERD: Scenario = {
  name: "herd",
  clients: 100,
  startSpreadSec: 0,
  maxAttempts: 10,
  server: { ratePerSec: 10, burst: 10 },
  seed: 11,
};

describe("full simulation runs", () => {
  it("is bit-for-bit reproducible for the same seed", () => {
    const a = runScenario(HERD, exponentialFullJitter(1, 30));
    const b = runScenario(HERD, exponentialFullJitter(1, 30));
    expect(a.metrics).toEqual(b.metrics);
    expect(a.results).toEqual(b.results);
  });

  it("changes outcomes when the seed changes", () => {
    const a = runScenario(HERD, exponentialFullJitter(1, 30));
    const b = runScenario({ ...HERD, seed: 12 }, exponentialFullJitter(1, 30));
    expect(a.results).not.toEqual(b.results);
  });

  it("full jitter breaks up the herd that no-jitter keeps synchronized", () => {
    const noJitter = runScenario(HERD, exponential(1, 30)).metrics;
    const fullJitter = runScenario(HERD, exponentialFullJitter(1, 30)).metrics;
    // Synchronized waves re-collide at exactly the same instants; jittered
    // retries almost never share one. (1-second arrival buckets cannot see
    // this — sub-second jitter lands in the same bucket as the wave it left.)
    expect(noJitter.maxRetryCollision).toBeGreaterThan(10 * fullJitter.maxRetryCollision);
    expect(fullJitter.totalAttempts).toBeLessThan(noJitter.totalAttempts);
    expect(fullJitter.makespanSec!).toBeLessThan(noJitter.makespanSec!);
  });

  it("everyone eventually succeeds when capacity covers demand", () => {
    for (const policy of [exponential(1, 30), exponentialFullJitter(1, 30), fixedDelay(2)]) {
      const { metrics } = runScenario(HERD, policy);
      expect(metrics.successRate).toBe(1);
      expect(metrics.giveUps).toBe(0);
    }
  });

  it("a dead service exhausts every client's full attempt budget", () => {
    const dead: Scenario = {
      name: "dead",
      clients: 20,
      startSpreadSec: 0,
      maxAttempts: 5,
      server: { ratePerSec: 0, burst: 0 },
      seed: 13,
    };
    const { metrics, results } = runScenario(dead, exponentialFullJitter(1, 30));
    expect(metrics.successRate).toBe(0);
    expect(metrics.totalAttempts).toBe(20 * 5);
    expect(results.every((r) => r.attempts === 5)).toBe(true);
    expect(metrics.makespanSec).toBeNull();
    expect(metrics.capacityUtilization).toBeNull();
  });

  it("immediate retries burn the whole budget in one instant against a dead service", () => {
    const dead: Scenario = {
      name: "dead",
      clients: 10,
      startSpreadSec: 0,
      maxAttempts: 5,
      server: { ratePerSec: 0, burst: 0 },
      seed: 14,
    };
    const { results, server } = runScenario(dead, immediate());
    expect(server.peakArrivalsPerSec()).toBe(50);
    expect(results.every((r) => r.finishTimeSec === 0)).toBe(true);
  });

  it("during an outage, exact Retry-After stampedes the recovery instant", () => {
    const outage: Scenario = {
      name: "outage",
      clients: 100,
      startSpreadSec: 5,
      maxAttempts: 10,
      server: { ratePerSec: 20, burst: 20, outageUntilSec: 10 },
      seed: 15,
    };
    const exact = runScenario(outage, retryAfterExact());
    const jittered = runScenario(outage, retryAfterJitter(1, 30));
    // All exact clients re-arrive inside the recovery second.
    expect(exact.server.arrivalsBetween(10, 11)).toBe(100);
    expect(jittered.server.arrivalsBetween(10, 11)).toBeLessThan(60);
    expect(jittered.metrics.successRate).toBe(1);
  });

  it("handles a zero-client scenario without NaN or crash", () => {
    const empty: Scenario = { ...HERD, clients: 0 };
    const { metrics } = runScenario(empty, exponentialFullJitter(1, 30));
    expect(metrics.clients).toBe(0);
    expect(metrics.successRate).toBe(0);
    expect(metrics.totalAttempts).toBe(0);
    expect(metrics.meanAttempts).toBe(0);
    expect(metrics.p50CompletionSec).toBeNull();
    expect(metrics.makespanSec).toBeNull();
  });

  it("handles a single client", () => {
    const single: Scenario = { ...HERD, clients: 1 };
    const { metrics } = runScenario(single, exponentialFullJitter(1, 30));
    expect(metrics.successes).toBe(1);
    expect(metrics.totalAttempts).toBe(1);
    expect(metrics.p50CompletionSec).toBe(0);
  });

  it("scales to an oversized herd without falling over", () => {
    const big: Scenario = {
      name: "big",
      clients: 2000,
      startSpreadSec: 0,
      maxAttempts: 12,
      server: { ratePerSec: 100, burst: 100 },
      seed: 16,
    };
    const { metrics } = runScenario(big, exponentialFullJitter(1, 30));
    expect(metrics.successRate).toBe(1);
    // 2000 clients over 100/s: ideal makespan is ~19s; jitter should land within 3x.
    expect(metrics.makespanSec!).toBeLessThan(60);
  });
});
