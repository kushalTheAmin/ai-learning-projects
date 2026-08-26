/**
 * Retry delay policies. `attempt` is the 1-based index of the retry being
 * scheduled (attempt 1 = first retry, after the first failure). The jitter
 * variants follow the AWS Architecture Blog formulations: full jitter draws
 * from [0, exp), equal jitter keeps half the exponential delay and jitters
 * the rest, decorrelated jitter draws from [base, prevDelay * 3) and is the
 * only policy that depends on the previous delay rather than the attempt
 * number.
 */

import type { Rng } from "../../05-token-streaming/src/rng.js";

export type BackoffPolicy =
  | { kind: "fixed"; delayMs: number }
  | { kind: "exponential"; baseMs: number; capMs: number }
  | { kind: "full-jitter"; baseMs: number; capMs: number }
  | { kind: "equal-jitter"; baseMs: number; capMs: number }
  | { kind: "decorrelated-jitter"; baseMs: number; capMs: number };

const MAX_DOUBLINGS = 40; // 2^40 * any sane base already exceeds any sane cap

/** Capped exponential delay for a given retry attempt. */
export function cappedExponential(baseMs: number, capMs: number, attempt: number): number {
  return Math.min(capMs, baseMs * 2 ** Math.min(attempt - 1, MAX_DOUBLINGS));
}

export function nextDelayMs(
  policy: BackoffPolicy,
  attempt: number,
  prevDelayMs: number | undefined,
  rng: Rng,
): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error(`attempt must be a positive integer, got ${attempt}`);
  }
  switch (policy.kind) {
    case "fixed":
      return policy.delayMs;
    case "exponential":
      return cappedExponential(policy.baseMs, policy.capMs, attempt);
    case "full-jitter": {
      const exp = cappedExponential(policy.baseMs, policy.capMs, attempt);
      return rng() * exp;
    }
    case "equal-jitter": {
      const exp = cappedExponential(policy.baseMs, policy.capMs, attempt);
      return exp / 2 + rng() * (exp / 2);
    }
    case "decorrelated-jitter": {
      const prev = prevDelayMs ?? policy.baseMs;
      const hi = Math.max(policy.baseMs, prev * 3);
      return Math.min(policy.capMs, policy.baseMs + rng() * (hi - policy.baseMs));
    }
  }
}
