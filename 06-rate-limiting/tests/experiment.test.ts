import { describe, expect, it } from "vitest";
import { runScenario, type ScenarioOptions, type StrategySpec } from "../src/experiment.js";

function makeOpts(overrides: Partial<ScenarioOptions> = {}): ScenarioOptions {
  return {
    clients: 8,
    requestsPerClient: 3,
    serverRatePerSec: 10,
    serverBurst: 5,
    faultRate: 0.05,
    latencyMsMin: 10,
    latencyMsMax: 30,
    advertiseRetryAfter: true,
    seed: 42,
    peakWindowMs: 100,
    ...overrides,
  };
}

const FULL_JITTER: StrategySpec = {
  name: "full-jitter",
  retry: {
    policy: { kind: "full-jitter", baseMs: 50, capMs: 5_000 },
    maxRetries: 8,
    respectRetryAfter: false,
  },
};

const NO_JITTER: StrategySpec = {
  name: "no-jitter",
  retry: {
    policy: { kind: "exponential", baseMs: 50, capMs: 5_000 },
    maxRetries: 8,
    respectRetryAfter: false,
  },
};

describe("runScenario", () => {
  it("is deterministic: identical inputs give identical results", async () => {
    const a = await runScenario(FULL_JITTER, makeOpts());
    const b = await runScenario(FULL_JITTER, makeOpts());
    expect(a).toEqual(b);
  });

  it("accounts for every request: succeeded + failed = clients * requestsPerClient", async () => {
    const r = await runScenario(FULL_JITTER, makeOpts());
    expect(r.requests).toBe(8 * 3);
    expect(r.succeeded + r.failed).toBe(r.requests);
    expect(r.totalAttempts).toBe(r.count429 + r.count503 + r.succeeded);
  });

  it("handles zero clients without dividing by zero", async () => {
    const r = await runScenario(FULL_JITTER, makeOpts({ clients: 0 }));
    expect(r.requests).toBe(0);
    expect(r.makespanMs).toBe(0);
    expect(Number.isNaN(r.attemptsPerSuccess)).toBe(true);
    expect(Number.isNaN(r.p50LatencyMs)).toBe(true);
  });

  it("handles a single client with a single request", async () => {
    const r = await runScenario(FULL_JITTER, makeOpts({ clients: 1, requestsPerClient: 1, faultRate: 0 }));
    expect(r).toMatchObject({ requests: 1, succeeded: 1, failed: 0, totalAttempts: 1, count429: 0 });
  });

  it("reports a latency over every request, not only over the ones that succeeded", async () => {
    // 20 clients, one request each, all at t=0 against a burst of 2: two are
    // admitted and pay 10ms, eighteen are rejected instantly and give up. A
    // success-only median says 10ms; the median request took 0ms.
    const r = await runScenario(
      { name: "no-retry", retry: { policy: { kind: "none" }, maxRetries: 0, respectRetryAfter: false } },
      makeOpts({
        clients: 20,
        requestsPerClient: 1,
        serverBurst: 2,
        faultRate: 0,
        latencyMsMin: 10,
        latencyMsMax: 10,
      }),
    );
    expect(r.succeeded).toBe(2);
    expect(r.failed).toBe(18);
    expect(r.p50LatencyMs).toBe(10);
    expect(r.p50AllMs).toBe(0);
  });

  it("counts the time a given-up request spent retrying", async () => {
    // Every request is rejected, so each burns its whole retry budget: three
    // 10ms waits before giving up at 30ms. No request succeeds, so the
    // success-only percentile has nothing to report and the all-request one
    // still does.
    const r = await runScenario(
      {
        name: "doomed",
        retry: { policy: { kind: "fixed", delayMs: 10 }, maxRetries: 3, respectRetryAfter: false },
      },
      makeOpts({ clients: 4, requestsPerClient: 1, serverRatePerSec: 1, serverBurst: 1, faultRate: 1 }),
    );
    expect(r.succeeded).toBe(0);
    expect(Number.isNaN(r.p50LatencyMs)).toBe(true);
    expect(r.p50AllMs).toBeGreaterThan(0);
  });

  it("reports failures when demand far exceeds capacity and retries run out", async () => {
    const r = await runScenario(
      {
        name: "starved",
        retry: { policy: { kind: "fixed", delayMs: 10 }, maxRetries: 1, respectRetryAfter: false },
      },
      makeOpts({ clients: 50, requestsPerClient: 2, serverRatePerSec: 2, serverBurst: 1, faultRate: 0 }),
    );
    expect(r.failed).toBeGreaterThan(0);
    expect(r.succeeded + r.failed).toBe(100);
    expect(r.count429).toBeGreaterThan(r.failed); // failed requests burned retries too
  });

  it("client pacing at the server rate eliminates 429s", async () => {
    const paced: StrategySpec = {
      ...FULL_JITTER,
      name: "paced",
      clientPacing: { ratePerSec: 10, burst: 5 },
    };
    const r = await runScenario(paced, makeOpts({ faultRate: 0 }));
    expect(r.count429).toBe(0);
    expect(r.succeeded).toBe(r.requests);
    expect(r.totalAttempts).toBe(r.requests);
  });

  it("with faults, pacing leaks 429s through unpaced retries, and stolen tokens can bounce a paced first attempt", async () => {
    const paced: StrategySpec = {
      ...FULL_JITTER,
      name: "paced",
      clientPacing: { ratePerSec: 10, burst: 5 },
    };
    const r = await runScenario(paced, makeOpts({ faultRate: 0.1 }));
    // 503 retries re-enter without a pacing token. Each one that lands steals
    // a server token the pacing bucket already promised to a first attempt,
    // so first-attempt 429s are possible but stay rare (1 of 27 on this seed).
    expect(r.count503).toBe(6);
    expect(r.count429).toBe(27);
    expect(r.count429OnFirstAttempt).toBe(1);
  });

  it("shows retry synchronization: no-jitter retries collide, jittered retries do not", async () => {
    const opts = makeOpts({ clients: 20, requestsPerClient: 3, faultRate: 0.02 });
    const noJitter = await runScenario(NO_JITTER, opts);
    const fullJitter = await runScenario(FULL_JITTER, opts);
    // 15 of the 20 first attempts are rejected at t=0 and all wake at exactly
    // base delay with no jitter; real-valued jittered delays never collide.
    expect(noJitter.maxSimultaneousRetries).toBeGreaterThanOrEqual(10);
    expect(fullJitter.maxSimultaneousRetries).toBeLessThanOrEqual(1);
    expect(noJitter.maxSimultaneousRetries).toBeGreaterThan(fullJitter.maxSimultaneousRetries);
  });
});
