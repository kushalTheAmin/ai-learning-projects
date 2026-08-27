/**
 * One scenario = one strategy against a fresh server, same seeds. Every
 * client fires at t=0 (the thundering herd) and works through its requests
 * sequentially. All randomness is seeded and all time is virtual, so a
 * scenario is a pure function of (strategy, options).
 */

import { VirtualClock } from "./clock.js";
import { PacingLimiter } from "./limiter.js";
import { percentile } from "./percentile.js";
import { requestWithRetry, type RequestOutcome, type RetryOptions } from "./retry.js";
import { SimulatedApi } from "./server.js";
import { createRng } from "../../05-token-streaming/src/rng.js";

export interface StrategySpec {
  name: string;
  retry: RetryOptions;
  /** When set, all clients share a pacing bucket at this rate. */
  clientPacing?: { ratePerSec: number; burst: number };
}

export interface ScenarioOptions {
  clients: number;
  requestsPerClient: number;
  serverRatePerSec: number;
  serverBurst: number;
  faultRate: number;
  latencyMsMin: number;
  latencyMsMax: number;
  advertiseRetryAfter: boolean;
  seed: number;
  peakWindowMs: number;
}

export interface StrategyResult {
  name: string;
  requests: number;
  succeeded: number;
  failed: number;
  totalAttempts: number;
  attemptsPerSuccess: number;
  count429: number;
  count429OnFirstAttempt: number;
  count503: number;
  makespanMs: number;
  p50LatencyMs: number;
  p99LatencyMs: number;
  peakArrivalsPerWindow: number;
  maxSimultaneousRetries: number;
}

export async function runScenario(
  spec: StrategySpec,
  opts: ScenarioOptions,
): Promise<StrategyResult> {
  if (!Number.isInteger(opts.clients) || opts.clients < 0) {
    throw new Error(`clients must be a non-negative integer, got ${opts.clients}`);
  }
  if (!Number.isInteger(opts.requestsPerClient) || opts.requestsPerClient < 0) {
    throw new Error(`requestsPerClient must be a non-negative integer, got ${opts.requestsPerClient}`);
  }
  const clock = new VirtualClock();
  const serverRng = createRng(opts.seed);
  const api = new SimulatedApi(clock, serverRng, {
    ratePerSec: opts.serverRatePerSec,
    burst: opts.serverBurst,
    faultRate: opts.faultRate,
    latencyMsMin: opts.latencyMsMin,
    latencyMsMax: opts.latencyMsMax,
    advertiseRetryAfter: opts.advertiseRetryAfter,
  });
  const limiter = spec.clientPacing
    ? new PacingLimiter(spec.clientPacing.ratePerSec, spec.clientPacing.burst, clock)
    : undefined;

  const outcomes: RequestOutcome[] = [];
  const runClient = async (clientIndex: number): Promise<void> => {
    // Each client draws from its own seeded stream so jitter is independent
    // across clients but reproducible across runs.
    const clientRng = createRng(opts.seed + 1 + clientIndex);
    for (let i = 0; i < opts.requestsPerClient; i++) {
      if (limiter) await limiter.acquire();
      outcomes.push(
        await requestWithRetry((attempt) => api.request(attempt > 1), clock, clientRng, spec.retry),
      );
    }
  };

  const allClients = Promise.all(
    Array.from({ length: opts.clients }, (_, i) => runClient(i)),
  );
  await clock.runUntil(allClients);

  const succeeded = outcomes.filter((o) => o.ok);
  const latencies = succeeded.map((o) => o.endMs - o.startMs).sort((a, b) => a - b);
  return {
    name: spec.name,
    requests: outcomes.length,
    succeeded: succeeded.length,
    failed: outcomes.length - succeeded.length,
    totalAttempts: api.totalAttempts(),
    attemptsPerSuccess: succeeded.length === 0 ? Number.NaN : api.totalAttempts() / succeeded.length,
    count429: api.count429,
    count429OnFirstAttempt: api.count429OnFirstAttempt,
    count503: api.count503,
    makespanMs: outcomes.length === 0 ? 0 : Math.max(...outcomes.map((o) => o.endMs)),
    p50LatencyMs: latencies.length === 0 ? Number.NaN : percentile(latencies, 0.5),
    p99LatencyMs: latencies.length === 0 ? Number.NaN : percentile(latencies, 0.99),
    peakArrivalsPerWindow: api.peakArrivalsPerWindow(opts.peakWindowMs),
    maxSimultaneousRetries: api.maxSimultaneousRetries(),
  };
}
