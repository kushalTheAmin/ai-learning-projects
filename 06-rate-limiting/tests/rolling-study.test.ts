import { describe, expect, it } from "vitest";
import { runBreakerScenario, type BreakerScenarioOptions, type BreakerStrategySpec } from "../src/breaker-study.js";

const RETRY = {
  policy: { kind: "full-jitter", baseMs: 100, capMs: 10_000 } as const,
  maxRetries: 8,
  respectRetryAfter: false,
};

const DEAD: BreakerScenarioOptions = {
  clients: 8,
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

function rollingSpec(minVolume: number, scope: "per-client" | "shared"): BreakerStrategySpec {
  return {
    name: "rolling",
    retry: RETRY,
    breaker: {
      detector: { kind: "rolling", windowMs: 1_000, errorRateThreshold: 0.5, minVolume },
      openMs: 2_000,
      scope,
      mode: "fail-fast",
      count429: false,
    },
  };
}

describe("runBreakerScenario with a rolling detector", () => {
  it("a shared rolling breaker trips on a dead service and collapses the bill", async () => {
    const plain = await runBreakerScenario({ name: "plain", retry: RETRY }, DEAD);
    const rolling = await runBreakerScenario(rollingSpec(5, "shared"), DEAD);
    expect(rolling.trips).toBeGreaterThanOrEqual(1);
    expect(rolling.fastFailed).toBeGreaterThan(0);
    expect(rolling.breakerRejections).toBeGreaterThan(0);
    expect(rolling.wireAttempts).toBeLessThan(plain.wireAttempts);
  });

  it("a volume-starved per-client rolling breaker never fires and matches no-breaker exactly", async () => {
    const plain = await runBreakerScenario({ name: "plain", retry: RETRY }, DEAD);
    const starved = await runBreakerScenario(rollingSpec(20, "per-client"), DEAD);
    expect(starved.trips).toBe(0);
    expect(starved.fastFailed).toBe(0);
    expect(starved.wireAttempts).toBe(plain.wireAttempts);
    expect(starved.succeeded).toBe(plain.succeeded);
    expect(starved.makespanMs).toBe(plain.makespanMs);
  });

  it("on a flaky healthy service the counter can trip where the rate holds", async () => {
    const flaky: BreakerScenarioOptions = {
      clients: 20,
      requestsPerClient: 10,
      serverRatePerSec: 4000,
      serverBurst: 4000,
      faultRate: 0.3,
      latencyMsMin: 20,
      latencyMsMax: 60,
      advertiseRetryAfter: false,
      outageMs: 0,
      advertiseOutageRetryAfter: false,
      seed: 1016,
    };
    const counter = await runBreakerScenario(
      {
        name: "cons",
        retry: RETRY,
        breaker: {
          detector: { kind: "consecutive", failureThreshold: 5 },
          openMs: 2_000,
          scope: "shared",
          mode: "fail-fast",
          count429: false,
        },
      },
      flaky,
    );
    const rolling = await runBreakerScenario(rollingSpec(20, "shared"), flaky);
    expect(counter.trips).toBeGreaterThanOrEqual(1);
    expect(rolling.trips).toBe(0);
    expect(rolling.succeeded).toBeGreaterThan(counter.succeeded);
    expect(rolling.fastFailed).toBe(0);
  });

  it("rejects invalid rolling options through the config", async () => {
    const bad = rollingSpec(5, "shared");
    bad.breaker!.detector = { kind: "rolling", windowMs: -1, errorRateThreshold: 0.5, minVolume: 5 };
    await expect(runBreakerScenario(bad, DEAD)).rejects.toThrow(/windowMs/);
  });
});
