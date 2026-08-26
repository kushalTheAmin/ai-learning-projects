/**
 * Token-bucket rate-limited server. Requests either take a token or are
 * rejected with an integer Retry-After hint, the way real APIs answer 429/503.
 * An optional outage window rejects everything before `outageUntilSec`.
 *
 * The bucket refills continuously at `ratePerSec` up to `burst`. Capacity that
 * arrives while the bucket is already full is lost — which is exactly what a
 * synchronized retry wave wastes.
 */
import type { Simulation } from "./sim.js";

export interface ServerOptions {
  ratePerSec: number;
  burst: number;
  outageUntilSec?: number;
}

export type AcquireResult =
  | { ok: true }
  | { ok: false; retryAfterSec: number };

export class TokenBucketServer {
  private readonly sim: Simulation;
  private readonly ratePerSec: number;
  private readonly burst: number;
  private readonly outageUntilSec: number;
  private tokens: number;
  private lastRefillSec: number;

  /** Arrivals per 1-second bucket, keyed by floor(arrival time). */
  private readonly arrivalsBySecond = new Map<number, number>();
  /** Retry arrivals keyed by exact arrival instant — the collision histogram. */
  private readonly retryArrivalsByInstant = new Map<number, number>();
  totalArrivals = 0;
  totalRejections = 0;

  constructor(sim: Simulation, opts: ServerOptions) {
    if (opts.ratePerSec < 0 || opts.burst < 0) {
      throw new RangeError("ratePerSec and burst must be >= 0");
    }
    this.sim = sim;
    this.ratePerSec = opts.ratePerSec;
    this.burst = opts.burst;
    this.outageUntilSec = opts.outageUntilSec ?? 0;
    this.tokens = opts.burst;
    this.lastRefillSec = sim.now;
  }

  tryAcquire(isRetry = false): AcquireResult {
    const now = this.sim.now;
    this.recordArrival(now, isRetry);
    this.refill(now);

    if (now < this.outageUntilSec) {
      this.totalRejections++;
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil(this.outageUntilSec - now)) };
    }
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { ok: true };
    }
    this.totalRejections++;
    const retryAfterSec =
      this.ratePerSec > 0
        ? Math.max(1, Math.ceil((1 - this.tokens) / this.ratePerSec))
        : Number.POSITIVE_INFINITY;
    return { ok: false, retryAfterSec };
  }

  private refill(now: number): void {
    const elapsed = now - this.lastRefillSec;
    if (elapsed > 0) {
      this.tokens = Math.min(this.burst, this.tokens + elapsed * this.ratePerSec);
      this.lastRefillSec = now;
    }
  }

  private recordArrival(now: number, isRetry: boolean): void {
    this.totalArrivals++;
    const bucket = Math.floor(now);
    this.arrivalsBySecond.set(bucket, (this.arrivalsBySecond.get(bucket) ?? 0) + 1);
    if (isRetry) {
      this.retryArrivalsByInstant.set(now, (this.retryArrivalsByInstant.get(now) ?? 0) + 1);
    }
  }

  /** Largest number of arrivals landing inside any single 1-second bucket. */
  peakArrivalsPerSec(): number {
    let peak = 0;
    for (const count of this.arrivalsBySecond.values()) {
      if (count > peak) peak = count;
    }
    return peak;
  }

  /**
   * Largest number of retries landing at exactly the same simulated instant.
   * This is the herd-synchronization measure: deterministic backoff schedules
   * re-collide here, jittered ones almost never do. First attempts are
   * excluded because the retry policy has no say over them.
   */
  maxRetryCollision(): number {
    let peak = 0;
    for (const count of this.retryArrivalsByInstant.values()) {
      if (count > peak) peak = count;
    }
    return peak;
  }

  /** Arrivals with floor(time) in [fromSec, toSec). */
  arrivalsBetween(fromSec: number, toSec: number): number {
    let total = 0;
    for (const [bucket, count] of this.arrivalsBySecond) {
      if (bucket >= fromSec && bucket < toSec) total += count;
    }
    return total;
  }
}
