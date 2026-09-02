/**
 * Header-informed pacing: a client-side pacer that reads the server's
 * RateLimit headers instead of (or before) learning from 429s.
 *
 * Two modes:
 *
 * - "trust-limit": believe the advertised limit outright. One response turns
 *   the unknown-budget problem into the oracle's problem, headroom included.
 *
 * - "remaining-only": the limit header is missing or untrusted; recover the
 *   refill rate from remaining-token deltas plus the pacer's own count of
 *   admitted responses. Over any observation window where the bucket never
 *   hits its cap, (remaining_b - remaining_a + admitted_in_window) is exactly
 *   the refill, whatever the drain was. The regimes are asymmetric: an empty
 *   bucket is fully informative (every refilled token is taken and counted),
 *   a full bucket is censored (refill is discarded at the cap and leaves no
 *   trace). Censored windows still carry one bit, capacity >= current send
 *   rate, so they drive an additive probe instead of an estimate update.
 */

import { TokenBucket } from "./bucket.js";
import type { VirtualClock } from "./clock.js";
import type { ApiResponse } from "./server.js";

export interface HeaderPacerOptions {
  mode: "trust-limit" | "remaining-only";
  /** Send rate before the first header arrives. */
  initialRatePerSec: number;
  minRatePerSec: number;
  maxRatePerSec: number;
  /** Fraction of believed capacity to pace at, in (0, 1]. */
  headroom: number;
  burst: number;
  /** remaining-only: minimum window between estimate updates. */
  minWindowMs?: number;
  /** remaining-only: EWMA weight of a fresh window estimate, in (0, 1]. */
  ewmaAlpha?: number;
  /** remaining-only: additive probe rate applied over censored windows. */
  probeIncreasePerSec?: number;
  /**
   * remaining-only: a window endpoint within this many tokens of the highest
   * remaining ever seen counts as at-cap, so the window is treated as
   * censored rather than fed to the estimator.
   */
  capSlackTokens?: number;
}

interface Anchor {
  atMs: number;
  remaining: number;
}

export class HeaderPacer {
  private readonly bucket: TokenBucket;
  /** Believed server capacity in req/s; the paced rate is headroom * this. */
  private believed: number;
  private anchor?: Anchor;
  private admittedSinceAnchor = 0;
  private maxRemainingSeen = 0;
  /** Responses that carried headers. */
  headerObservations = 0;
  /** Windows fed to the estimator (remaining-only). */
  estimateUpdates = 0;
  /** Censored windows that drove a probe instead (remaining-only). */
  probeUpdates = 0;

  constructor(
    private readonly opts: HeaderPacerOptions,
    private readonly clock: VirtualClock,
  ) {
    if (opts.mode !== "trust-limit" && opts.mode !== "remaining-only") {
      throw new Error(`mode must be "trust-limit" or "remaining-only", got ${String(opts.mode)}`);
    }
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
      throw new Error(`initialRatePerSec must lie in [min, max], got ${opts.initialRatePerSec}`);
    }
    if (!Number.isFinite(opts.headroom) || opts.headroom <= 0 || opts.headroom > 1) {
      throw new Error(`headroom must be in (0, 1], got ${opts.headroom}`);
    }
    const minWindow = opts.minWindowMs ?? 500;
    if (!Number.isFinite(minWindow) || minWindow <= 0) {
      throw new Error(`minWindowMs must be positive, got ${minWindow}`);
    }
    const alpha = opts.ewmaAlpha ?? 0.5;
    if (!Number.isFinite(alpha) || alpha <= 0 || alpha > 1) {
      throw new Error(`ewmaAlpha must be in (0, 1], got ${alpha}`);
    }
    const probe = opts.probeIncreasePerSec ?? 2;
    if (!Number.isFinite(probe) || probe <= 0) {
      throw new Error(`probeIncreasePerSec must be positive, got ${probe}`);
    }
    const slack = opts.capSlackTokens ?? 3;
    if (!Number.isFinite(slack) || slack < 0) {
      throw new Error(`capSlackTokens must be a finite non-negative number, got ${slack}`);
    }
    this.believed = opts.initialRatePerSec / opts.headroom;
    this.bucket = new TokenBucket(opts.initialRatePerSec, opts.burst, clock);
  }

  currentRatePerSec(): number {
    return this.bucket.currentRatePerSec();
  }

  /** Believed server capacity before the headroom discount. */
  believedCapacityPerSec(): number {
    return this.believed;
  }

  async acquire(): Promise<void> {
    while (!this.bucket.tryTake()) {
      await this.clock.sleep(Math.max(1, this.bucket.msUntilNextToken()));
    }
  }

  /**
   * Feed every response in. Header-less responses (an outage rejection, a
   * server that stopped advertising) leave the controller untouched.
   */
  observe(res: ApiResponse): void {
    const headers = res.headers;
    if (!headers) return;
    this.headerObservations++;

    if (this.opts.mode === "trust-limit") {
      this.setBelieved(headers.limitPerSec);
      return;
    }

    // An admitted response's own token take is already reflected in its
    // remaining snapshot, so counting it keeps the window arithmetic exact.
    const admitted = res.status !== 429;
    const now = this.clock.now();
    this.maxRemainingSeen = Math.max(this.maxRemainingSeen, headers.remaining);
    if (!this.anchor) {
      this.anchor = { atMs: now, remaining: headers.remaining };
      return;
    }
    if (admitted) this.admittedSinceAnchor++;
    const elapsedMs = now - this.anchor.atMs;
    if (elapsedMs < (this.opts.minWindowMs ?? 500)) return;

    // Censoring needs evidence a cap exists: a bucket only ever seen near
    // empty is the informative regime, not a capped one, however small the
    // numbers. Without this guard a client joining mid-congestion would read
    // remaining 0 as "at cap" and probe upward into a wall of 429s.
    const slack = this.opts.capSlackTokens ?? 3;
    const capFloor = this.maxRemainingSeen - slack;
    const censored =
      this.maxRemainingSeen > slack &&
      (this.anchor.remaining >= capFloor || headers.remaining >= capFloor);
    if (censored) {
      // The bucket touched its cap: refill was discarded unseen, but a full
      // bucket proves capacity is at least the current drain, so probe up.
      this.probeUpdates++;
      this.setBelieved(this.believed + ((this.opts.probeIncreasePerSec ?? 2) * elapsedMs) / 1000);
    } else {
      const refillEst =
        ((headers.remaining - this.anchor.remaining + this.admittedSinceAnchor) * 1000) / elapsedMs;
      const alpha = this.opts.ewmaAlpha ?? 0.5;
      this.estimateUpdates++;
      this.setBelieved((1 - alpha) * this.believed + alpha * Math.max(0, refillEst));
    }
    this.anchor = { atMs: now, remaining: headers.remaining };
    this.admittedSinceAnchor = 0;
  }

  private setBelieved(capacityPerSec: number): void {
    const floor = this.opts.minRatePerSec / this.opts.headroom;
    const ceiling = this.opts.maxRatePerSec / this.opts.headroom;
    this.believed = Math.min(ceiling, Math.max(floor, capacityPerSec));
    this.bucket.setRate(
      Math.min(
        this.opts.maxRatePerSec,
        Math.max(this.opts.minRatePerSec, this.believed * this.opts.headroom),
      ),
    );
  }
}
