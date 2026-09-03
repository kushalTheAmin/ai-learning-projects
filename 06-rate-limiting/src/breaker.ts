/**
 * Circuit breaker: the memory across requests that the retry loop lacks.
 * Closed, a detector watches settled outcomes; when it trips the breaker
 * opens and rejects callers without touching the wire. After openMs of
 * cooldown a single half-open probe is admitted: its success closes the
 * breaker, its failure restarts the cooldown. Results from requests admitted
 * before a trip settle late; while open they are ignored, so stragglers
 * neither extend nor cut short the cooldown.
 *
 * A response that the caller's failure predicate does not count (say a 429
 * when only 503s count) settles as success: the service answered, which is
 * evidence of life.
 *
 * Two detectors share that gate machinery. CircuitBreaker counts consecutive
 * counted failures, the shape of the original extension. RollingWindowBreaker
 * (rolling-breaker.ts) judges the failure rate over a rolling time window
 * once a minimum volume of settles is in it, the shape production breakers
 * (hystrix, envoy) actually use.
 */

import type { VirtualClock } from "./clock.js";

export interface BreakerOptions {
  /** Consecutive counted failures that trip the breaker open. */
  failureThreshold: number;
  /**
   * Cooldown before an open breaker admits its half-open probe. 0 means the
   * breaker never rejects while no probe is in flight: every attempt after a
   * trip is itself the probe.
   */
  openMs: number;
}

export type BreakerState = "closed" | "open" | "half-open";

export type BreakerGate = { admitted: false } | { admitted: true; probe: boolean };

/** The gate surface the retry loop drives; both breaker classes provide it. */
export interface Breaker {
  state(): BreakerState;
  tryAcquire(): BreakerGate;
  msUntilProbe(): number;
  settle(gate: { probe: boolean }, countedOk: boolean): void;
  trips: number;
  probes: number;
  rejections: number;
}

/**
 * The open/half-open/probe machinery, detector left abstract. recordSettle
 * sees every counted outcome that arrives while the breaker is closed and
 * returns true to trip; resetDetector runs when a probe success closes the
 * breaker and when a trip discards the evidence that caused it.
 */
export abstract class GatedBreaker implements Breaker {
  private isOpen = false;
  private openedAtMs = 0;
  private probeInFlight = false;
  /** Times the breaker went from closed to open. */
  trips = 0;
  /** Half-open probes admitted. */
  probes = 0;
  /** Acquisitions rejected without touching the wire. */
  rejections = 0;

  constructor(
    protected readonly clock: VirtualClock,
    private readonly cooldownMs: number,
  ) {
    if (!Number.isFinite(cooldownMs) || cooldownMs < 0) {
      throw new Error(`openMs must be a finite non-negative number, got ${cooldownMs}`);
    }
  }

  protected abstract recordSettle(countedOk: boolean): boolean;
  protected abstract resetDetector(): void;

  state(): BreakerState {
    if (!this.isOpen) return "closed";
    return this.clock.now() >= this.openedAtMs + this.cooldownMs ? "half-open" : "open";
  }

  /**
   * Ask to send a request. Closed admits everyone; half-open admits exactly
   * one probe at a time; open rejects. Every admitted gate must be settled
   * exactly once with the outcome of its request.
   */
  tryAcquire(): BreakerGate {
    if (!this.isOpen) return { admitted: true, probe: false };
    if (this.state() === "half-open" && !this.probeInFlight) {
      this.probeInFlight = true;
      this.probes++;
      return { admitted: true, probe: true };
    }
    this.rejections++;
    return { admitted: false };
  }

  /** Ms until a probe could be admitted; 0 when closed or the cooldown is spent. */
  msUntilProbe(): number {
    if (!this.isOpen) return 0;
    return Math.max(0, this.openedAtMs + this.cooldownMs - this.clock.now());
  }

  /**
   * Report the outcome of an admitted request. `countedOk` is the breaker's
   * view: true for a success or for a failure the caller's predicate does
   * not count.
   */
  settle(gate: { probe: boolean }, countedOk: boolean): void {
    if (gate.probe) {
      if (!this.probeInFlight) {
        throw new Error("settling a probe the breaker did not admit");
      }
      this.probeInFlight = false;
      if (countedOk) {
        this.isOpen = false;
        this.resetDetector();
      } else {
        this.openedAtMs = this.clock.now();
      }
      return;
    }
    if (this.isOpen) return; // straggler admitted before the trip; the cooldown stands
    if (this.recordSettle(countedOk)) {
      this.isOpen = true;
      this.openedAtMs = this.clock.now();
      this.trips++;
      this.resetDetector();
    }
  }
}

export class CircuitBreaker extends GatedBreaker {
  private consecutiveFailures = 0;
  private readonly failureThreshold: number;

  constructor(clock: VirtualClock, opts: BreakerOptions) {
    if (!Number.isInteger(opts.failureThreshold) || opts.failureThreshold < 1) {
      throw new Error(`failureThreshold must be a positive integer, got ${opts.failureThreshold}`);
    }
    super(clock, opts.openMs);
    this.failureThreshold = opts.failureThreshold;
  }

  protected override recordSettle(countedOk: boolean): boolean {
    if (countedOk) {
      this.consecutiveFailures = 0;
      return false;
    }
    this.consecutiveFailures++;
    return this.consecutiveFailures >= this.failureThreshold;
  }

  protected override resetDetector(): void {
    this.consecutiveFailures = 0;
  }
}
