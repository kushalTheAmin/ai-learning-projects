import { describe, expect, it } from "vitest";
import { VirtualClock } from "../src/clock.js";
import { PacingLimiter } from "../src/limiter.js";

describe("PacingLimiter", () => {
  it("passes the burst through immediately, then paces at the rate", async () => {
    const clock = new VirtualClock();
    const limiter = new PacingLimiter(10, 2, clock); // 2 burst, then one per 100ms
    const grantTimes: number[] = [];
    const work = (async () => {
      for (let i = 0; i < 5; i++) {
        await limiter.acquire();
        grantTimes.push(clock.now());
      }
    })();
    await clock.runUntil(work);
    expect(grantTimes).toEqual([0, 0, 100, 200, 300]);
  });

  it("bounds throughput under concurrent contention", async () => {
    const clock = new VirtualClock();
    const limiter = new PacingLimiter(10, 1, clock);
    const grantTimes: number[] = [];
    const work = Promise.all(
      Array.from({ length: 8 }, async () => {
        await limiter.acquire();
        grantTimes.push(clock.now());
      }),
    );
    await clock.runUntil(work);
    expect(grantTimes).toHaveLength(8);
    // No 100ms window may grant more than one token after the burst.
    const sorted = [...grantTimes].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(100);
    }
    expect(Math.max(...grantTimes)).toBeGreaterThanOrEqual(700);
  });
});
