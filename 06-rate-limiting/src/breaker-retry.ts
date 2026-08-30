/**
 * The retry loop with a circuit breaker in front of the wire. Same policy
 * semantics as requestWithRetry (429 and 503 both retryable, Retry-After
 * respected when asked, budget counted in wire attempts), plus a gate check
 * before every attempt. Two behaviors when the gate rejects:
 *
 *   fail-fast: the request fails immediately with "breaker-open". The caller
 *     stops hanging, and no retry budget is spent on a breaker that already
 *     knows the answer.
 *   wait: the request sleeps until the breaker's next probe window and asks
 *     again. Waiting costs no budget; the probe itself is a wire attempt and
 *     is counted like any other.
 *
 * A request that trips the breaker still sleeps its own backoff delay before
 * meeting the open gate: standard breaker wrappers reject the next call, not
 * the one in flight, and the delay between attempts belongs to the retry
 * policy.
 */

import { nextDelayMs } from "./backoff.js";
import type { CircuitBreaker } from "./breaker.js";
import type { VirtualClock } from "./clock.js";
import type { RetryOptions } from "./retry.js";
import type { ApiResponse } from "./server.js";
import type { Rng } from "../../05-token-streaming/src/rng.js";

export type BreakerMode = "fail-fast" | "wait";

export interface BreakerRequestOutcome {
  ok: boolean;
  /** Attempts that actually reached the server. Can be 0 under fail-fast. */
  wireAttempts: number;
  /** True when the request ended on a breaker rejection, not a server answer. */
  fastFailed: boolean;
  startMs: number;
  endMs: number;
  finalStatus: 200 | 429 | 503 | "breaker-open";
}

export async function requestWithBreaker(
  send: (attempt: number) => Promise<ApiResponse>,
  clock: VirtualClock,
  rng: Rng,
  opts: RetryOptions,
  breaker: CircuitBreaker,
  mode: BreakerMode,
  countsAsFailure: (res: ApiResponse) => boolean,
): Promise<BreakerRequestOutcome> {
  if (!Number.isInteger(opts.maxRetries) || opts.maxRetries < 0) {
    throw new Error(`maxRetries must be a non-negative integer, got ${opts.maxRetries}`);
  }
  const startMs = clock.now();
  let prevDelayMs: number | undefined;
  let wireAttempts = 0;
  for (;;) {
    const gate = breaker.tryAcquire();
    if (!gate.admitted) {
      if (mode === "fail-fast") {
        return {
          ok: false,
          wireAttempts,
          fastFailed: true,
          startMs,
          endMs: clock.now(),
          finalStatus: "breaker-open",
        };
      }
      // Probe window still closed, or another caller holds the probe: sleep
      // to the window (at least 1ms so a contended probe is polled, never
      // spun on at a single virtual instant) and ask again.
      await clock.sleep(Math.max(1, breaker.msUntilProbe()));
      continue;
    }
    wireAttempts++;
    const res = await send(wireAttempts);
    breaker.settle(gate, res.status === 200 || !countsAsFailure(res));
    if (res.status === 200) {
      return { ok: true, wireAttempts, fastFailed: false, startMs, endMs: clock.now(), finalStatus: 200 };
    }
    const retriesUsed = wireAttempts - 1;
    if (opts.policy.kind === "none" || retriesUsed >= opts.maxRetries) {
      return { ok: false, wireAttempts, fastFailed: false, startMs, endMs: clock.now(), finalStatus: res.status };
    }
    let delayMs = nextDelayMs(opts.policy, wireAttempts, prevDelayMs, rng);
    prevDelayMs = delayMs;
    if (opts.respectRetryAfter && res.retryAfterMs !== undefined) {
      delayMs = Math.max(delayMs, res.retryAfterMs);
    }
    await clock.sleep(delayMs);
  }
}
