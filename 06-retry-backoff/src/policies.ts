/**
 * Retry delay policies. Each answers one question: attempt N just failed —
 * how long until the next try? Giving up is the client's job (maxAttempts),
 * so every policy is comparable under the same failure budget.
 *
 * The exponential family follows the standard formulation: raw backoff is
 * min(cap, base * 2^(attempt-1)), and the jitter variants randomize around it.
 */
import type { Rng } from "../../05-token-streaming/src/rng.js";

export interface PolicyContext {
  /** 1-based index of the attempt that just failed. */
  attempt: number;
  /** Delay used before the failed attempt; 0 when it was the first. */
  prevDelaySec: number;
  /** Server's Retry-After hint for this rejection. May be Infinity. */
  retryAfterSec: number;
  rng: Rng;
}

export interface RetryPolicy {
  readonly name: string;
  nextDelaySec(ctx: PolicyContext): number;
}

function expoBackoff(baseSec: number, capSec: number, attempt: number): number {
  // Clamp the exponent so the intermediate product cannot overflow to Infinity.
  return Math.min(capSec, baseSec * 2 ** Math.min(attempt - 1, 40));
}

function randBetween(rng: Rng, lo: number, hi: number): number {
  return lo + rng() * (hi - lo);
}

export function immediate(): RetryPolicy {
  return { name: "immediate", nextDelaySec: () => 0 };
}

export function fixedDelay(delaySec: number): RetryPolicy {
  return { name: `fixed(${delaySec}s)`, nextDelaySec: () => delaySec };
}

export function exponential(baseSec: number, capSec: number): RetryPolicy {
  return {
    name: "expo-no-jitter",
    nextDelaySec: ({ attempt }) => expoBackoff(baseSec, capSec, attempt),
  };
}

export function exponentialFullJitter(baseSec: number, capSec: number): RetryPolicy {
  return {
    name: "expo-full-jitter",
    nextDelaySec: ({ attempt, rng }) => randBetween(rng, 0, expoBackoff(baseSec, capSec, attempt)),
  };
}

export function exponentialEqualJitter(baseSec: number, capSec: number): RetryPolicy {
  return {
    name: "expo-equal-jitter",
    nextDelaySec: ({ attempt, rng }) => {
      const half = expoBackoff(baseSec, capSec, attempt) / 2;
      return half + randBetween(rng, 0, half);
    },
  };
}

/**
 * Decorrelated jitter: each delay is drawn from [base, 3 * previous delay],
 * capped. Grows on repeated failure like exponential backoff but without a
 * deterministic schedule for herds to synchronize on.
 */
export function decorrelatedJitter(baseSec: number, capSec: number): RetryPolicy {
  return {
    name: "decorrelated-jitter",
    nextDelaySec: ({ prevDelaySec, rng }) => {
      const prev = prevDelaySec > 0 ? prevDelaySec : baseSec;
      return Math.min(capSec, randBetween(rng, baseSec, prev * 3));
    },
  };
}

/** Obey the server's Retry-After hint to the letter. */
export function retryAfterExact(): RetryPolicy {
  return {
    name: "retry-after-exact",
    nextDelaySec: ({ retryAfterSec }) => retryAfterSec,
  };
}

/** Retry-After as a floor, plus a full-jittered exponential term on top. */
export function retryAfterJitter(baseSec: number, capSec: number): RetryPolicy {
  return {
    name: "retry-after-jitter",
    nextDelaySec: ({ attempt, retryAfterSec, rng }) =>
      retryAfterSec + randBetween(rng, 0, expoBackoff(baseSec, capSec, attempt)),
  };
}
