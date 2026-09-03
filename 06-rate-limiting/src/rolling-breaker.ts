/**
 * Rolling-window breaker: trips on a failure rate, not a failure streak.
 * Every counted settle lands in a time window covering (now - windowMs, now];
 * once the window holds at least minVolume settles and the failed fraction
 * reaches errorRateThreshold, the breaker opens. A success never resets
 * anything, it just dilutes the rate, and old evidence ages out of the
 * window instead of being wiped by one good response.
 *
 * The volume floor is the whole design: below it the rate is noise (1 of 1
 * failed is "100%"), so the breaker refuses to judge. The cost of that
 * refusal is that a caller too slow to put minVolume settles inside one
 * window can never trip it, however dead the dependency, and exponential
 * backoff actively spreads evidence thinner as things get worse. This
 * detector wants aggregate traffic; the consecutive counter works at any
 * volume.
 *
 * Open/half-open/probe behavior is GatedBreaker's, identical to
 * CircuitBreaker. A trip discards the window; a probe success closes with an
 * empty window, so re-tripping needs minVolume fresh settles.
 */

import { GatedBreaker } from "./breaker.js";
import type { VirtualClock } from "./clock.js";

export interface RollingBreakerOptions {
  /** Width of the rolling window settles are judged over. */
  windowMs: number;
  /** Failed fraction of the window that trips the breaker, in (0, 1]. */
  errorRateThreshold: number;
  /** Settles the window must hold before the rate is judged at all. */
  minVolume: number;
  /** Cooldown before an open breaker admits its half-open probe. */
  openMs: number;
}

interface WindowEntry {
  atMs: number;
  failed: boolean;
}

export class RollingWindowBreaker extends GatedBreaker {
  private entries: WindowEntry[] = [];
  private head = 0;
  private failures = 0;

  constructor(
    clock: VirtualClock,
    private readonly rollingOpts: RollingBreakerOptions,
  ) {
    if (!Number.isFinite(rollingOpts.windowMs) || rollingOpts.windowMs <= 0) {
      throw new Error(`windowMs must be a positive finite number, got ${rollingOpts.windowMs}`);
    }
    if (
      !Number.isFinite(rollingOpts.errorRateThreshold) ||
      rollingOpts.errorRateThreshold <= 0 ||
      rollingOpts.errorRateThreshold > 1
    ) {
      throw new Error(`errorRateThreshold must be in (0, 1], got ${rollingOpts.errorRateThreshold}`);
    }
    if (!Number.isInteger(rollingOpts.minVolume) || rollingOpts.minVolume < 1) {
      throw new Error(`minVolume must be a positive integer, got ${rollingOpts.minVolume}`);
    }
    super(clock, rollingOpts.openMs);
  }

  /** Settles currently inside the window. */
  windowVolume(): number {
    this.evict();
    return this.entries.length - this.head;
  }

  /** Failed settles currently inside the window. */
  windowFailures(): number {
    this.evict();
    return this.failures;
  }

  private evict(): void {
    const cutoff = this.clock.now() - this.rollingOpts.windowMs;
    while (this.head < this.entries.length && this.entries[this.head]!.atMs <= cutoff) {
      if (this.entries[this.head]!.failed) this.failures--;
      this.head++;
    }
    if (this.head > 1024 && this.head * 2 >= this.entries.length) {
      this.entries = this.entries.slice(this.head);
      this.head = 0;
    }
  }

  protected override recordSettle(countedOk: boolean): boolean {
    this.evict();
    this.entries.push({ atMs: this.clock.now(), failed: !countedOk });
    if (!countedOk) this.failures++;
    const volume = this.entries.length - this.head;
    return (
      volume >= this.rollingOpts.minVolume &&
      this.failures / volume >= this.rollingOpts.errorRateThreshold
    );
  }

  protected override resetDetector(): void {
    this.entries = [];
    this.head = 0;
    this.failures = 0;
  }
}
