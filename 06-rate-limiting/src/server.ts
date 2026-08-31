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
  | { status: 503; retryAfterMs?: number };

export interface OutageOptions {
  /**
   * Hard-down window [startMs, endMs): every request inside it fails with an
   * instant 503, before admission control, so outage rejections never drain
   * the rate budget. endMs of Infinity models a service that never recovers.
   */
  startMs: number;
  endMs: number;
  /** Whether outage 503s advertise the time until endMs as Retry-After. */
  advertiseRetryAfter: boolean;
}

export interface ServerOptions {
  ratePerSec: number;
  burst: number;
  /** Probability an admitted request fails transiently (503). */
  faultRate: number;
  latencyMsMin: number;
  latencyMsMax: number;
  /** Whether 429 responses carry a Retry-After hint. */
  advertiseRetryAfter: boolean;
  /**
   * Server-side hint jitter: a uniform integer in [0, hintJitterMs] added to
   * every advertised Retry-After (429 and outage 503 alike). Never subtracts,
   * so a compliant client never arrives before the hinted-at capacity exists.
   * Requires a dedicated hint rng so enabling it leaves the latency/fault
   * stream untouched.
   */
  hintJitterMs?: number;
  outage?: OutageOptions;
}

export class SimulatedApi {
  private readonly bucket: TokenBucket;
  readonly arrivalsMs: number[] = [];
  readonly retryArrivalsMs: number[] = [];
  count200 = 0;
  count429 = 0;
  count429OnFirstAttempt = 0;
  /** Timestamp of every 429, so studies can split rejections by time window. */
  readonly rejection429Ms: number[] = [];
  count503 = 0;
  /** Outage rejections, counted apart from transient 503s. */
  count503Outage = 0;

  constructor(
    private readonly clock: VirtualClock,
    private readonly rng: Rng,
    private readonly opts: ServerOptions,
    private readonly hintRng?: Rng,
  ) {
    if (opts.faultRate < 0 || opts.faultRate > 1) {
      throw new Error(`faultRate must be in [0, 1], got ${opts.faultRate}`);
    }
    if (opts.latencyMsMin < 0 || opts.latencyMsMax < opts.latencyMsMin) {
      throw new Error(
        `latency range must satisfy 0 <= min <= max, got [${opts.latencyMsMin}, ${opts.latencyMsMax}]`,
      );
    }
    const jitter = opts.hintJitterMs ?? 0;
    if (!Number.isFinite(jitter) || jitter < 0) {
      throw new Error(`hintJitterMs must be a finite non-negative number, got ${jitter}`);
    }
    if (jitter > 0 && !hintRng) {
      throw new Error("hintJitterMs > 0 requires a dedicated hint rng");
    }
    if (opts.outage) {
      const { startMs, endMs, advertiseRetryAfter } = opts.outage;
      if (!Number.isFinite(startMs) || startMs < 0 || endMs < startMs) {
        throw new Error(`outage window must satisfy 0 <= startMs <= endMs, got [${startMs}, ${endMs})`);
      }
      if (advertiseRetryAfter && !Number.isFinite(endMs)) {
        throw new Error("a service that never recovers cannot advertise a recovery time");
      }
    }
    this.bucket = new TokenBucket(opts.ratePerSec, opts.burst, clock);
  }

  totalAttempts(): number {
    return this.arrivalsMs.length;
  }

  /**
   * Change the admission rate from this instant on (capacity tightening or
   * recovering mid-run). Tokens already owed accrue at the old rate first.
   */
  setRate(ratePerSec: number): void {
    this.bucket.setRate(ratePerSec);
  }

  async request(isRetry = false): Promise<ApiResponse> {
    this.arrivalsMs.push(this.clock.now());
    if (isRetry) this.retryArrivalsMs.push(this.clock.now());
    const outage = this.opts.outage;
    if (outage && this.clock.now() >= outage.startMs && this.clock.now() < outage.endMs) {
      // Hard-down failure: instant, pre-admission, so a dying dependency's
      // rejections cost it nothing but also tell the client nothing about rate.
      this.count503Outage++;
      if (outage.advertiseRetryAfter) {
        return { status: 503, retryAfterMs: this.jitteredHint(Math.ceil(outage.endMs - this.clock.now())) };
      }
      return { status: 503 };
    }
    if (!this.bucket.tryTake()) {
      this.count429++;
      this.rejection429Ms.push(this.clock.now());
      if (!isRetry) this.count429OnFirstAttempt++;
      if (this.opts.advertiseRetryAfter) {
        return { status: 429, retryAfterMs: this.jitteredHint(this.bucket.msUntilNextToken()) };
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

  private jitteredHint(exactMs: number): number {
    const jitter = this.opts.hintJitterMs ?? 0;
    if (jitter === 0) return exactMs;
    return exactMs + randInt(this.hintRng!, 0, jitter);
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
