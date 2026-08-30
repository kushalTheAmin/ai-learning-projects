/**
 * Outage scenarios: the server is hard-down over [0, outageMs) and every
 * client arrives at t=0, so the whole herd meets the outage head on. Failures
 * here are outage-driven only (transient fault rate is 0), which makes
 * success/failure a pure read on whether a retry schedule outlives the
 * outage. outageMs of Infinity is the dead-service case: nobody can succeed,
 * and the measurement becomes what the retry traffic costs on the way down.
 */

import { VirtualClock } from "./clock.js";
import { percentile } from "./percentile.js";
import { requestWithRetry, type RequestOutcome, type RetryOptions } from "./retry.js";
import { SimulatedApi } from "./server.js";
import { createRng } from "../../05-token-streaming/src/rng.js";

export interface OutageStrategySpec {
  name: string;
  retry: RetryOptions;
}

export interface OutageScenarioOptions {
  clients: number;
  requestsPerClient: number;
  serverRatePerSec: number;
  serverBurst: number;
  latencyMsMin: number;
  latencyMsMax: number;
  /** Outage covers [0, outageMs); Infinity means the service never recovers. */
  outageMs: number;
  /** Whether outage 503s advertise the time until recovery. */
  advertiseOutageRetryAfter: boolean;
  /** Server-side jitter on every Retry-After hint; 0 = exact hints. */
  hintJitterMs: number;
  seed: number;
}

export interface OutageResult {
  name: string;
  requests: number;
  succeeded: number;
  failed: number;
  totalAttempts: number;
  /** Attempts that landed while the service was down: pure waste. */
  attemptsDuringOutage: number;
  attemptsAfterRecovery: number;
  /** Post-recovery 429s; outage rejections bypass admission so cannot 429. */
  count429: number;
  /** Peak arrivals in any 100ms window at or after recovery; NaN when dead. */
  recoveryPeakPer100ms: number;
  makespanMs: number;
  /** Time from recovery to the last request settling; NaN when dead. */
  drainMs: number;
  /** Latency of failed requests: how long a caller hangs before the give-up. */
  giveUpP50Ms: number;
  giveUpP99Ms: number;
  successP50Ms: number;
  /** Peak arrivals in any 1s window over the whole run. */
  peakAttemptsPerSec: number;
  maxSimultaneousRetries: number;
}

/** Arrivals with startMs <= t < endMs. */
export function countInRange(arrivalsMs: readonly number[], startMs: number, endMs: number): number {
  let count = 0;
  for (const t of arrivalsMs) {
    if (t >= startMs && t < endMs) count++;
  }
  return count;
}

/**
 * Largest number of arrivals inside any single window of `windowMs`, with
 * bins anchored at `fromMs` and arrivals before `fromMs` ignored, so a
 * recovery spike is measured against windows starting at the recovery
 * instant rather than wherever t=0 bins happen to fall.
 */
export function peakPerWindow(
  arrivalsMs: readonly number[],
  windowMs: number,
  fromMs = 0,
): number {
  if (windowMs <= 0) throw new Error(`windowMs must be positive, got ${windowMs}`);
  const counts = new Map<number, number>();
  for (const t of arrivalsMs) {
    if (t < fromMs) continue;
    const bin = Math.floor((t - fromMs) / windowMs);
    counts.set(bin, (counts.get(bin) ?? 0) + 1);
  }
  let peak = 0;
  for (const c of counts.values()) peak = Math.max(peak, c);
  return peak;
}

export async function runOutageScenario(
  spec: OutageStrategySpec,
  opts: OutageScenarioOptions,
): Promise<OutageResult> {
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
  const serverRng = createRng(opts.seed);
  const hintRng = opts.hintJitterMs > 0 ? createRng(opts.seed + 999_983) : undefined;
  const api = new SimulatedApi(
    clock,
    serverRng,
    {
      ratePerSec: opts.serverRatePerSec,
      burst: opts.serverBurst,
      faultRate: 0,
      latencyMsMin: opts.latencyMsMin,
      latencyMsMax: opts.latencyMsMax,
      advertiseRetryAfter: true,
      hintJitterMs: opts.hintJitterMs > 0 ? opts.hintJitterMs : undefined,
      outage: {
        startMs: 0,
        endMs: opts.outageMs,
        advertiseRetryAfter: opts.advertiseOutageRetryAfter,
      },
    },
    hintRng,
  );

  const outcomes: RequestOutcome[] = [];
  const runClient = async (clientIndex: number): Promise<void> => {
    const clientRng = createRng(opts.seed + 1 + clientIndex);
    for (let i = 0; i < opts.requestsPerClient; i++) {
      outcomes.push(
        await requestWithRetry((attempt) => api.request(attempt > 1), clock, clientRng, spec.retry),
      );
    }
  };
  const allClients = Promise.all(
    Array.from({ length: opts.clients }, (_, i) => runClient(i)),
  );
  await clock.runUntil(allClients);

  const dead = !Number.isFinite(opts.outageMs);
  const succeeded = outcomes.filter((o) => o.ok);
  const failed = outcomes.filter((o) => !o.ok);
  const successLatencies = succeeded.map((o) => o.endMs - o.startMs).sort((a, b) => a - b);
  const giveUpLatencies = failed.map((o) => o.endMs - o.startMs).sort((a, b) => a - b);
  const makespanMs = outcomes.length === 0 ? 0 : Math.max(...outcomes.map((o) => o.endMs));
  return {
    name: spec.name,
    requests: outcomes.length,
    succeeded: succeeded.length,
    failed: failed.length,
    totalAttempts: api.totalAttempts(),
    attemptsDuringOutage: countInRange(api.arrivalsMs, 0, opts.outageMs),
    attemptsAfterRecovery: dead ? 0 : countInRange(api.arrivalsMs, opts.outageMs, Number.POSITIVE_INFINITY),
    count429: api.count429,
    recoveryPeakPer100ms: dead ? Number.NaN : peakPerWindow(api.arrivalsMs, 100, opts.outageMs),
    makespanMs,
    drainMs: dead ? Number.NaN : Math.max(0, makespanMs - opts.outageMs),
    giveUpP50Ms: giveUpLatencies.length === 0 ? Number.NaN : percentile(giveUpLatencies, 0.5),
    giveUpP99Ms: giveUpLatencies.length === 0 ? Number.NaN : percentile(giveUpLatencies, 0.99),
    successP50Ms: successLatencies.length === 0 ? Number.NaN : percentile(successLatencies, 0.5),
    peakAttemptsPerSec: peakPerWindow(api.arrivalsMs, 1000),
    maxSimultaneousRetries: api.maxSimultaneousRetries(),
  };
}
