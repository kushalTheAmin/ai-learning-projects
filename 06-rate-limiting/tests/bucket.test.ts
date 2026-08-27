import { describe, expect, it } from "vitest";
import { TokenBucket } from "../src/bucket.js";

class FakeClock {
  private t = 0;
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

describe("TokenBucket", () => {
  it("rejects non-positive rate and burst below 1", () => {
    const clock = new FakeClock();
    expect(() => new TokenBucket(0, 5, clock)).toThrow(/ratePerSec/);
    expect(() => new TokenBucket(-1, 5, clock)).toThrow(/ratePerSec/);
    expect(() => new TokenBucket(10, 0, clock)).toThrow(/burst/);
  });

  it("serves the full burst then denies", () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket(10, 3, clock);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(false);
  });

  it("refills continuously at ratePerSec", () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket(10, 1, clock); // one token per 100ms
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(false);
    clock.advance(99);
    expect(bucket.tryTake()).toBe(false);
    clock.advance(1);
    expect(bucket.tryTake()).toBe(true);
  });

  it("never refills past the burst capacity", () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket(100, 2, clock);
    clock.advance(60_000);
    expect(bucket.availableTokens()).toBe(2);
  });

  it("reports the exact wait for the next token", () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket(10, 1, clock);
    expect(bucket.msUntilNextToken()).toBe(0);
    bucket.tryTake();
    expect(bucket.msUntilNextToken()).toBe(100);
    clock.advance(40);
    expect(bucket.msUntilNextToken()).toBe(60);
    clock.advance(60);
    expect(bucket.msUntilNextToken()).toBe(0);
  });
});
