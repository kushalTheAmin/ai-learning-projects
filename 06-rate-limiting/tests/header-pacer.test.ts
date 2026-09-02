import { describe, expect, it } from "vitest";
import { VirtualClock } from "../src/clock.js";
import { HeaderPacer, type HeaderPacerOptions } from "../src/header-pacer.js";
import { SimulatedApi, type ApiResponse, type ServerOptions } from "../src/server.js";
import { createRng } from "../../05-token-streaming/src/rng.js";

function serverOpts(overrides: Partial<ServerOptions> = {}): ServerOptions {
  return {
    ratePerSec: 10,
    burst: 2,
    faultRate: 0,
    latencyMsMin: 0,
    latencyMsMax: 0,
    advertiseRetryAfter: true,
    advertiseRateHeaders: true,
    ...overrides,
  };
}

describe("SimulatedApi rate headers", () => {
  it("attaches no headers unless asked", async () => {
    const clock = new VirtualClock();
    const api = new SimulatedApi(clock, createRng(1), serverOpts({ advertiseRateHeaders: false }));
    const res = await clock.runUntil(api.request());
    expect(res.status).toBe(200);
    expect(res.headers).toBeUndefined();
  });

  it("reports the advertised limit and whole remaining tokens at response time", async () => {
    const clock = new VirtualClock();
    const api = new SimulatedApi(clock, createRng(1), serverOpts());
    const work = (async () => {
      const first = await api.request(); // burst 2 -> 1 left
      const second = await api.request(); // -> 0 left
      const rejected = await api.request(); // 429, still 0
      return [first, second, rejected];
    })();
    const [first, second, rejected] = await clock.runUntil(work);
    expect(first!.headers).toEqual({ limitPerSec: 10, remaining: 1 });
    expect(second!.headers).toEqual({ limitPerSec: 10, remaining: 0 });
    expect(rejected!.status).toBe(429);
    expect(rejected!.headers).toEqual({ limitPerSec: 10, remaining: 0 });
  });

  it("floors fractional tokens and reflects a mid-run rate change", async () => {
    const clock = new VirtualClock();
    const api = new SimulatedApi(clock, createRng(1), serverOpts({ ratePerSec: 1, burst: 5 }));
    const work = (async () => {
      await api.request(); // 4 tokens left
      api.setRate(2);
      await clock.sleep(1750); // 4 + 3.5 refill, capped at 5, minus nothing
      return api.request(); // takes 1: 5 - 1 = 4 remaining, floor(4) = 4
    })();
    const res = await clock.runUntil(work);
    expect(res.headers).toEqual({ limitPerSec: 2, remaining: 4 });
  });

  it("attaches headers to transient 503s but never to outage 503s", async () => {
    const clock = new VirtualClock();
    const faulty = new SimulatedApi(clock, createRng(1), serverOpts({ faultRate: 1 }));
    const transient = await clock.runUntil(faulty.request());
    expect(transient.status).toBe(503);
    expect(transient.headers).toBeDefined();

    const down = new SimulatedApi(
      clock,
      createRng(1),
      serverOpts({ outage: { startMs: 0, endMs: 1000, advertiseRetryAfter: true } }),
    );
    const rejected = await clock.runUntil(down.request());
    expect(rejected.status).toBe(503);
    expect(rejected.headers).toBeUndefined();
  });
});

function pacerOpts(overrides: Partial<HeaderPacerOptions> = {}): HeaderPacerOptions {
  return {
    mode: "trust-limit",
    initialRatePerSec: 4,
    minRatePerSec: 1,
    maxRatePerSec: 40,
    headroom: 1,
    burst: 2,
    ...overrides,
  };
}

function ok(remaining: number, limitPerSec = 999): ApiResponse {
  return { status: 200, headers: { limitPerSec, remaining } };
}

function rejected(remaining: number, limitPerSec = 999): ApiResponse {
  return { status: 429, headers: { limitPerSec, remaining } };
}

describe("HeaderPacer", () => {
  it("validates its options", () => {
    const clock = new VirtualClock();
    expect(() => new HeaderPacer(pacerOpts({ mode: "psychic" as never }), clock)).toThrow(/mode/);
    expect(() => new HeaderPacer(pacerOpts({ minRatePerSec: 0 }), clock)).toThrow(/minRatePerSec/);
    expect(() => new HeaderPacer(pacerOpts({ maxRatePerSec: 0.5 }), clock)).toThrow(/maxRatePerSec/);
    expect(() => new HeaderPacer(pacerOpts({ initialRatePerSec: 100 }), clock)).toThrow(/initialRatePerSec/);
    expect(() => new HeaderPacer(pacerOpts({ headroom: 0 }), clock)).toThrow(/headroom/);
    expect(() => new HeaderPacer(pacerOpts({ headroom: 1.2 }), clock)).toThrow(/headroom/);
    expect(() => new HeaderPacer(pacerOpts({ ewmaAlpha: 0 }), clock)).toThrow(/ewmaAlpha/);
    expect(() => new HeaderPacer(pacerOpts({ minWindowMs: 0 }), clock)).toThrow(/minWindowMs/);
    expect(() => new HeaderPacer(pacerOpts({ probeIncreasePerSec: 0 }), clock)).toThrow(/probeIncreasePerSec/);
    expect(() => new HeaderPacer(pacerOpts({ capSlackTokens: -1 }), clock)).toThrow(/capSlackTokens/);
  });

  it("trust-limit adopts headroom times the advertised limit from one response", () => {
    const clock = new VirtualClock();
    const pacer = new HeaderPacer(pacerOpts({ headroom: 0.5 }), clock);
    expect(pacer.currentRatePerSec()).toBe(4);
    pacer.observe(ok(3, 20));
    expect(pacer.currentRatePerSec()).toBe(10);
    expect(pacer.believedCapacityPerSec()).toBe(20);
    expect(pacer.headerObservations).toBe(1);
  });

  it("trust-limit clamps to the configured rate bounds", () => {
    const clock = new VirtualClock();
    const pacer = new HeaderPacer(pacerOpts({ maxRatePerSec: 12 }), clock);
    pacer.observe(ok(0, 500));
    expect(pacer.currentRatePerSec()).toBe(12);
    pacer.observe(ok(0, 0.001));
    expect(pacer.currentRatePerSec()).toBe(1);
  });

  it("ignores responses without headers", () => {
    const clock = new VirtualClock();
    const pacer = new HeaderPacer(pacerOpts(), clock);
    pacer.observe({ status: 503 });
    expect(pacer.headerObservations).toBe(0);
    expect(pacer.currentRatePerSec()).toBe(4);
  });

  it("remaining-only recovers the refill rate from deltas plus admissions", async () => {
    const clock = new VirtualClock();
    // ewmaAlpha 1 makes one informative window authoritative, so the test
    // pins the window arithmetic itself, not the smoothing.
    const pacer = new HeaderPacer(
      pacerOpts({ mode: "remaining-only", ewmaAlpha: 1, minWindowMs: 1000, capSlackTokens: 0 }),
      clock,
    );
    const work = (async () => {
      pacer.observe(rejected(0)); // anchor at t=0, remaining 0
      await clock.sleep(500);
      pacer.observe(ok(0)); // admitted mid-window
      pacer.observe(ok(0)); // admitted mid-window
      await clock.sleep(500);
      pacer.observe(ok(0)); // closes the 1s window, third admission
    })();
    await clock.runUntil(work);
    // Refill over the window: (0 - 0) + 3 admissions in 1s = 3 req/s. The
    // advertised limit of 999 must play no part in remaining-only mode.
    expect(pacer.believedCapacityPerSec()).toBe(3);
    expect(pacer.currentRatePerSec()).toBe(3);
    expect(pacer.estimateUpdates).toBe(1);
    expect(pacer.probeUpdates).toBe(0);
  });

  it("remaining-only treats a bucket at its cap as censored and probes instead", async () => {
    const clock = new VirtualClock();
    const pacer = new HeaderPacer(
      pacerOpts({
        mode: "remaining-only",
        ewmaAlpha: 1,
        minWindowMs: 1000,
        probeIncreasePerSec: 2,
        capSlackTokens: 3,
      }),
      clock,
    );
    const work = (async () => {
      pacer.observe(ok(20)); // anchor at cap; maxRemainingSeen = 20
      await clock.sleep(1000);
      pacer.observe(ok(19)); // within slack of the cap: censored window
    })();
    await clock.runUntil(work);
    // No estimate: a capped bucket discarded refill unseen. Probe instead:
    // believed 4 + 2 req/s over 1s = 6.
    expect(pacer.estimateUpdates).toBe(0);
    expect(pacer.probeUpdates).toBe(1);
    expect(pacer.believedCapacityPerSec()).toBe(6);
  });

  it("remaining-only keeps probing up through consecutive censored windows", async () => {
    const clock = new VirtualClock();
    const pacer = new HeaderPacer(
      pacerOpts({ mode: "remaining-only", minWindowMs: 500, probeIncreasePerSec: 4 }),
      clock,
    );
    const work = (async () => {
      pacer.observe(ok(10));
      for (let i = 0; i < 4; i++) {
        await clock.sleep(500);
        pacer.observe(ok(10));
      }
    })();
    await clock.runUntil(work);
    // Four censored half-second windows at +4 req/s: 4 + 4 * 2 = 12.
    expect(pacer.probeUpdates).toBe(4);
    expect(pacer.believedCapacityPerSec()).toBe(12);
  });

  it("acquire spaces sends at the current rate on the virtual clock", async () => {
    const clock = new VirtualClock();
    const pacer = new HeaderPacer(pacerOpts({ initialRatePerSec: 10, burst: 1 }), clock);
    const work = (async () => {
      await pacer.acquire(); // burst token, t=0
      await pacer.acquire(); // must wait ~100ms for the next token
      return clock.now();
    })();
    const at = await clock.runUntil(work);
    expect(at).toBeGreaterThanOrEqual(100);
    expect(at).toBeLessThanOrEqual(110);
  });
});
