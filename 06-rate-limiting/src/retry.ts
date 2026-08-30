/**
 * The retry loop: hard-bounded attempts, policy-computed delays, optional
 * Retry-After compliance. 429 and 503 are both retryable; the loop never
 * spins without sleeping unless the policy explicitly returns a 0ms delay.
 */

import { nextDelayMs, type BackoffPolicy } from "./backoff.js";
import type { VirtualClock } from "./clock.js";
import type { ApiResponse } from "./server.js";
import type { Rng } from "../../05-token-streaming/src/rng.js";

export interface RetryOptions {
  policy: BackoffPolicy | { kind: "none" };
  /** Retries after the first attempt; 0 means a single attempt. */
  maxRetries: number;
  /** When true, any failure carrying Retry-After waits at least that long. */
  respectRetryAfter: boolean;
}

export interface RequestOutcome {
  ok: boolean;
  attempts: number;
  startMs: number;
  endMs: number;
  finalStatus: 200 | 429 | 503;
}

export async function requestWithRetry(
  send: (attempt: number) => Promise<ApiResponse>,
  clock: VirtualClock,
  rng: Rng,
  opts: RetryOptions,
): Promise<RequestOutcome> {
  if (!Number.isInteger(opts.maxRetries) || opts.maxRetries < 0) {
    throw new Error(`maxRetries must be a non-negative integer, got ${opts.maxRetries}`);
  }
  const startMs = clock.now();
  let prevDelayMs: number | undefined;
  for (let attempt = 1; ; attempt++) {
    const res = await send(attempt);
    if (res.status === 200) {
      return { ok: true, attempts: attempt, startMs, endMs: clock.now(), finalStatus: 200 };
    }
    const retriesUsed = attempt - 1;
    if (opts.policy.kind === "none" || retriesUsed >= opts.maxRetries) {
      return { ok: false, attempts: attempt, startMs, endMs: clock.now(), finalStatus: res.status };
    }
    let delayMs = nextDelayMs(opts.policy, attempt, prevDelayMs, rng);
    prevDelayMs = delayMs;
    if (opts.respectRetryAfter && res.retryAfterMs !== undefined) {
      delayMs = Math.max(delayMs, res.retryAfterMs);
    }
    await clock.sleep(delayMs);
  }
}
