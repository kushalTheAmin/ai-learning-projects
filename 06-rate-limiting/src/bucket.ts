/**
 * Token bucket with continuous refill: capacity `burst`, refilled at
 * `ratePerSec`, tokens computed lazily from elapsed clock time. Used on both
 * sides of the wire — as the server's admission control and as the client's
 * pacing limiter — so the two never disagree about what a rate means.
 */

export interface Clock {
  now(): number;
}

export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number,
    private readonly clock: Clock,
  ) {
    if (!Number.isFinite(ratePerSec) || ratePerSec <= 0) {
      throw new Error(`ratePerSec must be positive, got ${ratePerSec}`);
    }
    if (!Number.isFinite(burst) || burst < 1) {
      throw new Error(`burst must be at least 1, got ${burst}`);
    }
    this.tokens = burst;
    this.lastRefillMs = clock.now();
  }

  tryTake(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Milliseconds until one full token is available; 0 if one already is. */
  msUntilNextToken(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    return Math.ceil(((1 - this.tokens) / this.ratePerSec) * 1000);
  }

  availableTokens(): number {
    this.refill();
    return this.tokens;
  }

  private refill(): void {
    const now = this.clock.now();
    const elapsedSec = (now - this.lastRefillMs) / 1000;
    this.tokens = Math.min(this.burst, this.tokens + elapsedSec * this.ratePerSec);
    this.lastRefillMs = now;
  }
}
