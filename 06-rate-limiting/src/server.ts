/**
 * Simulated API endpoint: token-bucket admission control in front of a
 * processing stage with seeded latency and a seeded transient-fault rate.
 * Over-rate requests are rejected immediately with 429 (rejection is cheap;
 * that asymmetry is what makes unpaced retries look tempting). Admitted
 * requests pay processing latency and can still fail with a transient 503.
 * Every arrival is logged so the experiment can measure herd bursts.
 */

import { TokenBucket } from "./bucket.js";
import type { VirtualClock } from "./clock.js";
import { randInt, type Rng } from "../../05-token-streaming/src/rng.js";

export type ApiResponse =
  | { status: 200 }
  | { status: 429; retryAfterMs?: number }
  | { status: 503 };

export interface ServerOptions {
  ratePerSec: number;
  burst: number;
  /** Probability an admitted request fails transiently (503). */
  faultRate: number;
  latencyMsMin: number;
  latencyMsMax: number;
  /** Whether 429 responses carry a Retry-After hint. */
  advertiseRetryAfter: boolean;
}

export class SimulatedApi {
  private readonly bucket: TokenBucket;
  readonly arrivalsMs: number[] = [];
  readonly retryArrivalsMs: number[] = [];
  count200 = 0;
  count429 = 0;
  count429OnFirstAttempt = 0;
  count503 = 0;

  constructor(
    private readonly clock: VirtualClock,
    private readonly rng: Rng,
    private readonly opts: ServerOptions,
  ) {
    if (opts.faultRate < 0 || opts.faultRate > 1) {
      throw new Error(`faultRate must be in [0, 1], got ${opts.faultRate}`);
    }
    if (opts.latencyMsMin < 0 || opts.latencyMsMax < opts.latencyMsMin) {
      throw new Error(
        `latency range must satisfy 0 <= min <= max, got [${opts.latencyMsMin}, ${opts.latencyMsMax}]`,
      );
    }
    this.bucket = new TokenBucket(opts.ratePerSec, opts.burst, clock);
  }

  totalAttempts(): number {
    return this.arrivalsMs.length;
  }

  async request(isRetry = false): Promise<ApiResponse> {
    this.arrivalsMs.push(this.clock.now());
    if (isRetry) this.retryArrivalsMs.push(this.clock.now());
    if (!this.bucket.tryTake()) {
      this.count429++;
      if (!isRetry) this.count429OnFirstAttempt++;
      if (this.opts.advertiseRetryAfter) {
        return { status: 429, retryAfterMs: this.bucket.msUntilNextToken() };
      }
      return { status: 429 };
    }
    await this.clock.sleep(randInt(this.rng, this.opts.latencyMsMin, this.opts.latencyMsMax));
    if (this.rng() < this.opts.faultRate) {
      this.count503++;
      return { status: 503 };
    }
    this.count200++;
    return { status: 200 };
  }

  /** Largest number of arrivals landing inside any single window. */
  peakArrivalsPerWindow(windowMs: number): number {
    if (windowMs <= 0) throw new Error(`windowMs must be positive, got ${windowMs}`);
    const counts = new Map<number, number>();
    for (const t of this.arrivalsMs) {
      const bin = Math.floor(t / windowMs);
      counts.set(bin, (counts.get(bin) ?? 0) + 1);
    }
    let peak = 0;
    for (const c of counts.values()) peak = Math.max(peak, c);
    return peak;
  }

  /**
   * Largest number of retries arriving at the exact same instant, the
   * synchronization signature of jitterless backoff. Real-valued jittered
   * delays make exact collisions vanishingly rare; deterministic delays
   * make whole rejection waves collide.
   */
  maxSimultaneousRetries(): number {
    const counts = new Map<number, number>();
    for (const t of this.retryArrivalsMs) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    let peak = 0;
    for (const c of counts.values()) peak = Math.max(peak, c);
    return peak;
  }
}
