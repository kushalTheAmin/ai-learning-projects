/**
 * A client that needs exactly one successful request. It attempts, and on
 * rejection either retries after the policy's delay or gives up once the
 * attempt budget is spent. A non-finite delay (e.g. a Retry-After hint from a
 * server with zero capacity) is treated as "never" and the client gives up —
 * the hard-failure half of the policy.
 */
import type { Rng } from "../../05-token-streaming/src/rng.js";
import type { RetryPolicy } from "./policies.js";
import type { TokenBucketServer } from "./server.js";
import type { Simulation } from "./sim.js";

export interface ClientOptions {
  id: number;
  startTimeSec: number;
  maxAttempts: number;
  policy: RetryPolicy;
  rng: Rng;
}

export interface ClientResult {
  id: number;
  success: boolean;
  attempts: number;
  startTimeSec: number;
  /** Time of the success, or of the moment the client gave up. */
  finishTimeSec: number;
}

export function startClient(
  sim: Simulation,
  server: TokenBucketServer,
  opts: ClientOptions,
  onDone: (result: ClientResult) => void,
): void {
  if (opts.maxAttempts < 1) throw new RangeError("maxAttempts must be >= 1");
  let attempts = 0;
  let prevDelaySec = 0;

  const finish = (success: boolean): void => {
    onDone({
      id: opts.id,
      success,
      attempts,
      startTimeSec: opts.startTimeSec,
      finishTimeSec: sim.now,
    });
  };

  const tryOnce = (): void => {
    attempts++;
    const result = server.tryAcquire(attempts > 1);
    if (result.ok) {
      finish(true);
      return;
    }
    if (attempts >= opts.maxAttempts) {
      finish(false);
      return;
    }
    const delaySec = opts.policy.nextDelaySec({
      attempt: attempts,
      prevDelaySec,
      retryAfterSec: result.retryAfterSec,
      rng: opts.rng,
    });
    if (!Number.isFinite(delaySec)) {
      finish(false);
      return;
    }
    prevDelaySec = delaySec;
    sim.schedule(Math.max(0, delaySec), tryOnce);
  };

  sim.schedule(opts.startTimeSec, tryOnce);
}
