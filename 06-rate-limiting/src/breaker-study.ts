/**
 * Breaker scenarios: the same herd shapes as the main table and the outage
 * studies, with an optional circuit breaker between the retry loop and the
 * wire. Breaker scope is part of the strategy: per-client gives each client
 * its own memory across its sequential requests; shared gives every client
 * one view of the dependency, the shape of one process with many workers.
 * No breaker at all runs the plain retry loop, so baselines here are
 * comparable number for number with the earlier studies.
 */

import type { BreakerOptions } from "./breaker.js";
import { CircuitBreaker } from "./breaker.js";
import { requestWithBreaker, type BreakerMode, type BreakerRequestOutcome } from "./breaker-retry.js";
import { VirtualClock } from "./clock.js";
import { countInRange, peakPerWindow } from "./outage.js";
import { percentile } from "./percentile.js";
import { requestWithRetry, type RetryOptions } from "./retry.js";
import { SimulatedApi, type ApiResponse } from "./server.js";
import { createRng } from "../../05-token-streaming/src/rng.js";

export interface BreakerConfig extends BreakerOptions {
  scope: "per-client" | "shared";
  mode: BreakerMode;
  /** Whether 429s count as breaker failures; 503s always count. */
  count429: boolean;
}

export interface BreakerStrategySpec {
  name: string;
  retry: RetryOptions;
  breaker?: BreakerConfig;
}

export interface BreakerScenarioOptions {
  clients: number;
  requestsPerClient: number;
  serverRatePerSec: number;
  serverBurst: number;
  /** Probability an admitted request fails transiently (503). */
  faultRate: number;
  latencyMsMin: number;
  latencyMsMax: number;
  /** Whether 429s carry a Retry-After hint. */
  advertiseRetryAfter: boolean;
  /** Outage covers [0, outageMs); 0 = healthy, Infinity = never recovers. */
  outageMs: number;
  /** Whether outage 503s advertise the time until recovery. */
  advertiseOutageRetryAfter: boolean;
  seed: number;
}

export interface BreakerScenarioResult {
  name: string;
  requests: number;
  succeeded: number;
  failed: number;
  /** Failed requests that ended on a breaker rejection, not a server answer. */
  fastFailed: number;
  /** Attempts that reached the server. */
  wireAttempts: number;
  /** Acquisitions the breaker rejected without touching the wire. */
  breakerRejections: number;
  trips: number;
  probes: number;
  attemptsDuringOutage: number;
  count429: number;
  makespanMs: number;
  successP50Ms: number;
  /** Latency of failed requests: how long a caller hangs before the give-up. */
  giveUpP50Ms: number;
  giveUpP99Ms: number;
  /** Give-up latency split by position in the client's sequence: the first
   * request pays for the discovery, later ones inherit the breaker's memory. */
  firstGiveUpP50Ms: number;
  laterGiveUpP50Ms: number;
  peakAttemptsPerSec: number;
}

function p50(sortedMs: readonly number[]): number {
  return sortedMs.length === 0 ? Number.NaN : percentile(sortedMs, 0.5);
}

export async function runBreakerScenario(
  spec: BreakerStrategySpec,
  opts: BreakerScenarioOptions,
): Promise<BreakerScenarioResult> {
  if (!Number.isInteger(opts.clients) || opts.clients < 0) {
    throw new Error(`clients must be a non-negative integer, got ${opts.clients}`);
  }
  if (!Number.isInteger(opts.requestsPerClient) || opts.requestsPerClient < 0) {
    throw new Error(`requestsPerClient must be a non-negative integer, got ${opts.requestsPerClient}`);
  }
  if (!(opts.outageMs >= 0)) {
    throw new Error(`outageMs must be non-negative, got ${opts.outageMs}`);
  }
  const clock = new VirtualClock();
  const api = new SimulatedApi(clock, createRng(opts.seed), {
    ratePerSec: opts.serverRatePerSec,
    burst: opts.serverBurst,
    faultRate: opts.faultRate,
    latencyMsMin: opts.latencyMsMin,
    latencyMsMax: opts.latencyMsMax,
    advertiseRetryAfter: opts.advertiseRetryAfter,
    outage:
      opts.outageMs > 0
        ? { startMs: 0, endMs: opts.outageMs, advertiseRetryAfter: opts.advertiseOutageRetryAfter }
        : undefined,
  });

  const config = spec.breaker;
  const countsAsFailure = (res: ApiResponse): boolean =>
    res.status === 503 || (res.status === 429 && (config?.count429 ?? false));
  const breakers: CircuitBreaker[] = [];
  const sharedBreaker =
    config && config.scope === "shared"
      ? new CircuitBreaker(clock, { failureThreshold: config.failureThreshold, openMs: config.openMs })
      : undefined;
  if (sharedBreaker) breakers.push(sharedBreaker);

  const outcomes: { outcome: BreakerRequestOutcome; requestIndex: number }[] = [];
  const runClient = async (clientIndex: number): Promise<void> => {
    const clientRng = createRng(opts.seed + 1 + clientIndex);
    let breaker = sharedBreaker;
    if (config && !breaker) {
      breaker = new CircuitBreaker(clock, {
        failureThreshold: config.failureThreshold,
        openMs: config.openMs,
      });
      breakers.push(breaker);
    }
    for (let i = 0; i < opts.requestsPerClient; i++) {
      const send = (attempt: number): Promise<ApiResponse> => api.request(attempt > 1);
      if (breaker && config) {
        outcomes.push({
          outcome: await requestWithBreaker(send, clock, clientRng, spec.retry, breaker, config.mode, countsAsFailure),
          requestIndex: i,
        });
      } else {
        const plain = await requestWithRetry(send, clock, clientRng, spec.retry);
        outcomes.push({
          outcome: {
            ok: plain.ok,
            wireAttempts: plain.attempts,
            fastFailed: false,
            startMs: plain.startMs,
            endMs: plain.endMs,
            finalStatus: plain.finalStatus,
          },
          requestIndex: i,
        });
      }
    }
  };
  const allClients = Promise.all(Array.from({ length: opts.clients }, (_, i) => runClient(i)));
  await clock.runUntil(allClients);

  const all = outcomes.map((o) => o.outcome);
  const succeeded = all.filter((o) => o.ok);
  const failed = all.filter((o) => !o.ok);
  const latency = (o: BreakerRequestOutcome): number => o.endMs - o.startMs;
  const asc = (a: number, b: number): number => a - b;
  const successLatencies = succeeded.map(latency).sort(asc);
  const giveUpLatencies = failed.map(latency).sort(asc);
  const firstGiveUps = outcomes
    .filter((o) => !o.outcome.ok && o.requestIndex === 0)
    .map((o) => latency(o.outcome))
    .sort(asc);
  const laterGiveUps = outcomes
    .filter((o) => !o.outcome.ok && o.requestIndex > 0)
    .map((o) => latency(o.outcome))
    .sort(asc);
  return {
    name: spec.name,
    requests: all.length,
    succeeded: succeeded.length,
    failed: failed.length,
    fastFailed: failed.filter((o) => o.fastFailed).length,
    wireAttempts: api.totalAttempts(),
    breakerRejections: breakers.reduce((sum, b) => sum + b.rejections, 0),
    trips: breakers.reduce((sum, b) => sum + b.trips, 0),
    probes: breakers.reduce((sum, b) => sum + b.probes, 0),
    attemptsDuringOutage: countInRange(api.arrivalsMs, 0, opts.outageMs),
    count429: api.count429,
    makespanMs: all.length === 0 ? 0 : Math.max(...all.map((o) => o.endMs)),
    successP50Ms: p50(successLatencies),
    giveUpP50Ms: p50(giveUpLatencies),
    giveUpP99Ms: giveUpLatencies.length === 0 ? Number.NaN : percentile(giveUpLatencies, 0.99),
    firstGiveUpP50Ms: p50(firstGiveUps),
    laterGiveUpP50Ms: p50(laterGiveUps),
    peakAttemptsPerSec: peakPerWindow(api.arrivalsMs, 1000),
  };
}
