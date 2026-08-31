/**
 * AIMD adaptive pacing: a client-side pacer for a server whose rate budget
 * the client does not know. The send rate grows additively with clock time
 * (probing for headroom) and is cut multiplicatively when the server answers
 * 429 (backing out of congestion): TCP congestion control applied to request
 * pacing. One cut per congestion event: after a cut, 429s inside holdOffMs
 * are echoes of the same overshoot, not new evidence.
 */

import { TokenBucket } from "./bucket.js";
import type { VirtualClock } from "./clock.js";

export interface AimdOptions {
  initialRatePerSec: number;
  minRatePerSec: number;
  maxRatePerSec: number;
  /** Additive increase: req/s of send rate gained per second of clock time. */
  increasePerSec: number;
  /** Multiplicative decrease applied once per congestion event, in (0, 1). */
  decreaseFactor: number;
  /** After a cut, further 429 signals inside this window are ignored. */
  holdOffMs: number;
  burst: number;
}

export class AimdPacer {
  private rate: number;
  private growthAnchorMs: number;
  private lastCutMs = Number.NEGATIVE_INFINITY;
  private readonly bucket: TokenBucket;
  /** Congestion events acted on (429s inside a hold-off window not included). */
  cuts = 0;

  constructor(
    private readonly opts: AimdOptions,
    private readonly clock: VirtualClock,
  ) {
    if (!Number.isFinite(opts.minRatePerSec) || opts.minRatePerSec <= 0) {
      throw new Error(`minRatePerSec must be positive, got ${opts.minRatePerSec}`);
    }
    if (!Number.isFinite(opts.maxRatePerSec) || opts.maxRatePerSec < opts.minRatePerSec) {
      throw new Error(
        `maxRatePerSec must be at least minRatePerSec, got ${opts.maxRatePerSec} < ${opts.minRatePerSec}`,
      );
    }
    if (
      !Number.isFinite(opts.initialRatePerSec) ||
      opts.initialRatePerSec < opts.minRatePerSec ||
      opts.initialRatePerSec > opts.maxRatePerSec
    ) {
      throw new Error(
        `initialRatePerSec must lie in [min, max], got ${opts.initialRatePerSec}`,
      );
    }
    if (!Number.isFinite(opts.increasePerSec) || opts.increasePerSec <= 0) {
      throw new Error(`increasePerSec must be positive, got ${opts.increasePerSec}`);
    }
    if (!Number.isFinite(opts.decreaseFactor) || opts.decreaseFactor <= 0 || opts.decreaseFactor >= 1) {
      throw new Error(`decreaseFactor must be in (0, 1), got ${opts.decreaseFactor}`);
    }
    if (!Number.isFinite(opts.holdOffMs) || opts.holdOffMs < 0) {
      throw new Error(`holdOffMs must be a finite non-negative number, got ${opts.holdOffMs}`);
    }
    this.rate = opts.initialRatePerSec;
    this.growthAnchorMs = clock.now();
    this.bucket = new TokenBucket(opts.initialRatePerSec, opts.burst, clock);
  }

  currentRatePerSec(): number {
    this.applyGrowth();
    return this.rate;
  }

  async acquire(): Promise<void> {
    this.applyGrowth();
    while (!this.bucket.tryTake()) {
      await this.clock.sleep(Math.max(1, this.bucket.msUntilNextToken()));
      // The rate may have grown (or been cut) while this waiter slept.
      this.applyGrowth();
    }
  }

  /** Feed every 429 the server returns back in; the hold-off dedupes bursts. */
  on429(): void {
    const now = this.clock.now();
    if (now - this.lastCutMs < this.opts.holdOffMs) return;
    this.applyGrowth();
    this.rate = Math.max(this.opts.minRatePerSec, this.rate * this.opts.decreaseFactor);
    this.bucket.setRate(this.rate);
    this.lastCutMs = now;
    this.growthAnchorMs = now;
    this.cuts++;
  }

  private applyGrowth(): void {
    const now = this.clock.now();
    const elapsedSec = (now - this.growthAnchorMs) / 1000;
    if (elapsedSec <= 0) return;
    this.rate = Math.min(this.opts.maxRatePerSec, this.rate + elapsedSec * this.opts.increasePerSec);
    this.bucket.setRate(this.rate);
    this.growthAnchorMs = now;
  }
}
