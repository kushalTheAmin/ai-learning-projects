import { describe, expect, it } from "vitest";
import { TokenBucketServer } from "../src/server.js";
import { Simulation } from "../src/sim.js";

function at(sim: Simulation, timeSec: number, task: () => void): void {
  sim.schedule(timeSec, task);
}

describe("TokenBucketServer", () => {
  it("serves the burst instantly, then rejects", () => {
    const sim = new Simulation();
    const server = new TokenBucketServer(sim, { ratePerSec: 10, burst: 3 });
    const results: boolean[] = [];
    at(sim, 0, () => {
      for (let i = 0; i < 5; i++) results.push(server.tryAcquire().ok);
    });
    sim.run();
    expect(results).toEqual([true, true, true, false, false]);
    expect(server.totalArrivals).toBe(5);
    expect(server.totalRejections).toBe(2);
  });

  it("refills at ratePerSec up to burst, including fractional refill", () => {
    const sim = new Simulation();
    const server = new TokenBucketServer(sim, { ratePerSec: 2, burst: 4 });
    const oks: number[] = [];
    const drain = (): number => {
      let n = 0;
      while (server.tryAcquire().ok) n++;
      return n;
    };
    at(sim, 0, () => oks.push(drain())); // full burst
    at(sim, 0.25, () => oks.push(drain())); // 0.5 tokens refilled -> 0 whole
    at(sim, 1, () => oks.push(drain())); // 0.5 + 1.5 = 2 tokens
    at(sim, 100, () => oks.push(drain())); // long gap capped at burst
    sim.run();
    expect(oks).toEqual([4, 0, 2, 4]);
  });

  it("returns an integer Retry-After of at least 1 second when rate-limited", () => {
    const sim = new Simulation();
    const server = new TokenBucketServer(sim, { ratePerSec: 50, burst: 1 });
    let retryAfter = 0;
    at(sim, 0, () => {
      expect(server.tryAcquire().ok).toBe(true);
      const rejected = server.tryAcquire();
      if (!rejected.ok) retryAfter = rejected.retryAfterSec;
    });
    sim.run();
    // Time to next token is 1/50s, but the hint is coarse like a real header.
    expect(retryAfter).toBe(1);
  });

  it("rejects during an outage with the remaining outage as Retry-After", () => {
    const sim = new Simulation();
    const server = new TokenBucketServer(sim, { ratePerSec: 10, burst: 10, outageUntilSec: 10 });
    const hints: number[] = [];
    at(sim, 0, () => {
      const r = server.tryAcquire();
      if (!r.ok) hints.push(r.retryAfterSec);
    });
    at(sim, 9.5, () => {
      const r = server.tryAcquire();
      if (!r.ok) hints.push(r.retryAfterSec);
    });
    at(sim, 10, () => {
      expect(server.tryAcquire().ok).toBe(true);
    });
    sim.run();
    expect(hints).toEqual([10, 1]);
  });

  it("reports an infinite Retry-After when the rate is zero", () => {
    const sim = new Simulation();
    const server = new TokenBucketServer(sim, { ratePerSec: 0, burst: 0 });
    at(sim, 0, () => {
      const r = server.tryAcquire();
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.retryAfterSec).toBe(Number.POSITIVE_INFINITY);
    });
    sim.run();
  });

  it("counts arrivals per second bucket and finds the peak", () => {
    const sim = new Simulation();
    const server = new TokenBucketServer(sim, { ratePerSec: 1, burst: 1 });
    at(sim, 0.1, () => server.tryAcquire());
    at(sim, 0.9, () => server.tryAcquire());
    at(sim, 2.5, () => server.tryAcquire());
    at(sim, 2.6, () => server.tryAcquire());
    at(sim, 2.7, () => server.tryAcquire());
    sim.run();
    expect(server.peakArrivalsPerSec()).toBe(3);
    expect(server.arrivalsBetween(0, 1)).toBe(2);
    expect(server.arrivalsBetween(1, 2)).toBe(0);
    expect(server.arrivalsBetween(2, 3)).toBe(3);
    expect(server.arrivalsBetween(0, 10)).toBe(5);
  });

  it("counts only same-instant retry arrivals as collisions", () => {
    const sim = new Simulation();
    const server = new TokenBucketServer(sim, { ratePerSec: 1, burst: 1 });
    // Three first attempts collide at t=0 — not the retry policy's doing.
    at(sim, 0, () => {
      server.tryAcquire(false);
      server.tryAcquire(false);
      server.tryAcquire(false);
    });
    at(sim, 1, () => {
      server.tryAcquire(true);
      server.tryAcquire(true);
    });
    at(sim, 1.5, () => server.tryAcquire(true));
    sim.run();
    expect(server.maxRetryCollision()).toBe(2);
  });

  it("rejects negative rate or burst", () => {
    const sim = new Simulation();
    expect(() => new TokenBucketServer(sim, { ratePerSec: -1, burst: 1 })).toThrow(RangeError);
    expect(() => new TokenBucketServer(sim, { ratePerSec: 1, burst: -1 })).toThrow(RangeError);
  });
});
