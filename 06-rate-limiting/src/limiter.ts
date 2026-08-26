/**
 * Client-side pacing: a shared token bucket whose acquire() waits instead of
 * failing. Requests that would exceed the budget queue locally rather than
 * being sent to be rejected — turning server 429s into client-side waiting.
 */

import { TokenBucket } from "./bucket.js";
import type { VirtualClock } from "./clock.js";

export class PacingLimiter {
  private readonly bucket: TokenBucket;

  constructor(
    ratePerSec: number,
    burst: number,
    private readonly clock: VirtualClock,
  ) {
    this.bucket = new TokenBucket(ratePerSec, burst, clock);
  }

  async acquire(): Promise<void> {
    while (!this.bucket.tryTake()) {
      // Several waiters can wake for one token; the ones that lose wait again.
      await this.clock.sleep(Math.max(1, this.bucket.msUntilNextToken()));
    }
  }
}
