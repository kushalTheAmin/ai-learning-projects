import { describe, expect, it } from "vitest";
import { runBreakerScenario, type BreakerScenarioOptions } from "../src/breaker-study.js";
import { runOutageScenario } from "../src/outage.js";

const DEAD: BreakerScenarioOptions = {
  clients: 4,
  requestsPerClient: 3,
  serverRatePerSec: 20,
  serverBurst: 20,
  faultRate: 0,
  latencyMsMin: 20,
  latencyMsMax: 60,
  advertiseRetryAfter: false,
  outageMs: Number.POSITIVE_INFINITY,
  advertiseOutageRetryAfter: false,
  seed: 7,
};

const RETRY = {
  policy: { kind: "full-jitter", baseMs: 100, capMs: 10_000 } as const,
  maxRetries: 8,
  respectRetryAfter: false,
};

describe("runBreakerScenario", () => {
  it("validates its counts", async () => {
    await expect(runBreakerScenario({ name: "x", retry: RETRY }, { ...DEAD, clients: -1 })).rejects.toThrow(/clients/);
    await expect(
      runBreakerScenario({ name: "x", retry: RETRY }, { ...DEAD, requestsPerClient: 1.5 }),
    ).rejects.toThrow(/requestsPerClient/);
    await expect(runBreakerScenario({ name: "x", retry: RETRY }, { ...DEAD, outageMs: -5 })).rejects.toThrow(/outageMs/);
  });

  it("handles zero clients and zero requests", async () => {
    const none = await runBreakerScenario({ name: "x", retry: RETRY }, { ...DEAD, clients: 0 });
    expect(none.requests).toBe(0);
    expect(none.wireAttempts).toBe(0);
    expect(Number.isNaN(none.giveUpP50Ms)).toBe(true);
    const empty = await runBreakerScenario({ name: "x", retry: RETRY }, { ...DEAD, requestsPerClient: 0 });
    expect(empty.requests).toBe(0);
  });

  it("without a breaker reproduces the outage runner number for number", async () => {
    const viaBreakerRunner = await runBreakerScenario({ name: "plain", retry: RETRY }, DEAD);
    const viaOutageRunner = await runOutageScenario(
      { name: "plain", retry: RETRY },
      {
        clients: DEAD.clients,
        requestsPerClient: DEAD.requestsPerClient,
        serverRatePerSec: DEAD.serverRatePerSec,
        serverBurst: DEAD.serverBurst,
        latencyMsMin: DEAD.latencyMsMin,
        latencyMsMax: DEAD.latencyMsMax,
        outageMs: DEAD.outageMs,
        advertiseOutageRetryAfter: false,
        hintJitterMs: 0,
        seed: DEAD.seed,
      },
    );
    expect(viaBreakerRunner.wireAttempts).toBe(viaOutageRunner.totalAttempts);
    expect(viaBreakerRunner.makespanMs).toBe(viaOutageRunner.makespanMs);
    expect(viaBreakerRunner.giveUpP50Ms).toBe(viaOutageRunner.giveUpP50Ms);
    expect(viaBreakerRunner.trips).toBe(0);
    expect(viaBreakerRunner.breakerRejections).toBe(0);
  });

  it("per-client fail-fast on a dead service spends the threshold once per client", async () => {
    const r = await runBreakerScenario(
      {
        name: "k2",
        retry: RETRY,
        breaker: { failureThreshold: 2, openMs: 60_000, scope: "per-client", mode: "fail-fast", count429: false },
      },
      DEAD,
    );
    // Request 1 trips after exactly 2 wire attempts; requests 2 and 3 meet
    // the open gate inside the long cooldown and never reach the wire.
    expect(r.wireAttempts).toBe(2 * DEAD.clients);
    expect(r.trips).toBe(DEAD.clients);
    expect(r.probes).toBe(0);
    expect(r.succeeded).toBe(0);
    expect(r.fastFailed).toBe(3 * DEAD.clients);
    expect(r.laterGiveUpP50Ms).toBe(0);
  });

  it("a shared breaker floors at the number of concurrent first attempts", async () => {
    const r = await runBreakerScenario(
      {
        name: "shared",
        retry: RETRY,
        breaker: { failureThreshold: 2, openMs: 60_000, scope: "shared", mode: "fail-fast", count429: false },
      },
      DEAD,
    );
    // All 4 clients fire attempt 1 at t=0 before any settles, so 4 attempts
    // land on a breaker with threshold 2; everything after is rejected.
    expect(r.wireAttempts).toBe(DEAD.clients);
    expect(r.trips).toBe(1);
    expect(r.succeeded).toBe(0);
  });

  it("a healthy server with 503-only counting never trips and matches the plain run", async () => {
    const healthy: BreakerScenarioOptions = {
      ...DEAD,
      outageMs: 0,
      faultRate: 0.02,
      advertiseRetryAfter: true,
      clients: 10,
      requestsPerClient: 3,
    };
    const retry = { ...RETRY, respectRetryAfter: true };
    const plain = await runBreakerScenario({ name: "plain", retry }, healthy);
    const gated = await runBreakerScenario(
      {
        name: "gated",
        retry,
        breaker: { failureThreshold: 5, openMs: 2_000, scope: "per-client", mode: "fail-fast", count429: false },
      },
      healthy,
    );
    expect(gated.trips).toBe(0);
    expect(gated.wireAttempts).toBe(plain.wireAttempts);
    expect(gated.succeeded).toBe(plain.succeeded);
    expect(gated.makespanMs).toBe(plain.makespanMs);
  });

  it("wait mode on a dead service spends the whole budget as probes", async () => {
    const r = await runBreakerScenario(
      {
        name: "wait",
        retry: RETRY,
        breaker: { failureThreshold: 2, openMs: 1_000, scope: "per-client", mode: "wait", count429: false },
      },
      { ...DEAD, clients: 1, requestsPerClient: 1 },
    );
    // 2 attempts trip, then probes at 1s cadence until 9 total wire attempts.
    expect(r.wireAttempts).toBe(1 + RETRY.maxRetries);
    expect(r.probes).toBe(RETRY.maxRetries - 1);
    expect(r.succeeded).toBe(0);
    expect(r.fastFailed).toBe(0);
  });
});
