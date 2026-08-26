/**
 * Per-scenario metrics over client results plus the server's arrival
 * histogram. Percentiles use linear interpolation between order statistics.
 */
import type { ClientResult } from "./client.js";
import type { TokenBucketServer } from "./server.js";

export interface ScenarioMetrics {
  policyName: string;
  clients: number;
  successes: number;
  giveUps: number;
  successRate: number;
  totalAttempts: number;
  meanAttempts: number;
  /** Completion time (finish - start) over successful clients only. */
  p50CompletionSec: number | null;
  p95CompletionSec: number | null;
  maxCompletionSec: number | null;
  /** Simulated time of the last success; null if nothing succeeded. */
  makespanSec: number | null;
  peakArrivalsPerSec: number;
  /** Most retries landing at exactly the same simulated instant. */
  maxRetryCollision: number;
  /** successes / (ratePerSec * makespan): share of refilled capacity used. */
  capacityUtilization: number | null;
}

export function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) throw new RangeError("percentile of empty list");
  if (q < 0 || q > 1) throw new RangeError(`q must be in [0, 1], got ${q}`);
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (sorted.length - 1) * q;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const loVal = sorted[lo]!;
  const hiVal = sorted[hi]!;
  return loVal + (hiVal - loVal) * (rank - lo);
}

export function summarize(
  policyName: string,
  results: readonly ClientResult[],
  server: TokenBucketServer,
  ratePerSec: number,
): ScenarioMetrics {
  const successes = results.filter((r) => r.success);
  const completionTimes = successes.map((r) => r.finishTimeSec - r.startTimeSec);
  const totalAttempts = results.reduce((sum, r) => sum + r.attempts, 0);
  const makespanSec =
    successes.length > 0 ? Math.max(...successes.map((r) => r.finishTimeSec)) : null;
  return {
    policyName,
    clients: results.length,
    successes: successes.length,
    giveUps: results.length - successes.length,
    successRate: results.length > 0 ? successes.length / results.length : 0,
    totalAttempts,
    meanAttempts: results.length > 0 ? totalAttempts / results.length : 0,
    p50CompletionSec: completionTimes.length > 0 ? percentile(completionTimes, 0.5) : null,
    p95CompletionSec: completionTimes.length > 0 ? percentile(completionTimes, 0.95) : null,
    maxCompletionSec: completionTimes.length > 0 ? Math.max(...completionTimes) : null,
    makespanSec,
    peakArrivalsPerSec: server.peakArrivalsPerSec(),
    maxRetryCollision: server.maxRetryCollision(),
    capacityUtilization:
      makespanSec !== null && makespanSec > 0 && ratePerSec > 0
        ? successes.length / (ratePerSec * makespanSec)
        : null,
  };
}
