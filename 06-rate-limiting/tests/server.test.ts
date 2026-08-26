import { describe, expect, it } from "vitest";
import { VirtualClock } from "../src/clock.js";
import { SimulatedApi, type ServerOptions } from "../src/server.js";
import { createRng } from "../../05-token-streaming/src/rng.js";

function makeOpts(overrides: Partial<ServerOptions> = {}): ServerOptions {
  return {
    ratePerSec: 10,
    burst: 2,
    faultRate: 0,
    latencyMsMin: 10,
    latencyMsMax: 10,
    advertiseRetryAfter: true,
    ...overrides,
  };
}

describe("SimulatedApi", () => {
  it("validates fault rate and latency range", () => {
    const clock = new VirtualClock();
    const rng = createRng(1);
    expect(() => new SimulatedApi(clock, rng, makeOpts({ faultRate: 1.5 }))).toThrow(/faultRate/);
    expect(
      () => new SimulatedApi(clock, rng, makeOpts({ latencyMsMin: 20, latencyMsMax: 10 })),
    ).toThrow(/latency range/);
  });

  it("admits the burst, rejects the excess with 429 and a Retry-After hint", async () => {
    const clock = new VirtualClock();
    const api = new SimulatedApi(clock, createRng(1), makeOpts());
    const work = (async () => {
      const [a, b] = [api.request(), api.request()];
      const c = await api.request(); // third arrives while the burst is spent
      return [await a, await b, c];
    })();
    const [a, b, c] = await clock.runUntil(work);
    expect(a!.status).toBe(200);
    expect(b!.status).toBe(200);
    expect(c!.status).toBe(429);
    if (c!.status === 429) {
      expect(c!.retryAfterMs).toBe(100); // 10 req/s -> one token per 100ms
    }
    expect(api.count200).toBe(2);
    expect(api.count429).toBe(1);
  });

  it("omits Retry-After when not advertised", async () => {
    const clock = new VirtualClock();
    const api = new SimulatedApi(clock, createRng(1), makeOpts({ advertiseRetryAfter: false, burst: 1 }));
    const work = (async () => {
      const first = api.request();
      const second = await api.request();
      await first;
      return second;
    })();
    const rejected = await clock.runUntil(work);
    expect(rejected.status).toBe(429);
    if (rejected.status === 429) {
      expect(rejected.retryAfterMs).toBeUndefined();
    }
  });

  it("charges processing latency inside the configured range", async () => {
    const clock = new VirtualClock();
    const api = new SimulatedApi(clock, createRng(3), makeOpts({ latencyMsMin: 20, latencyMsMax: 60 }));
    const work = (async () => {
      const start = clock.now();
      await api.request();
      return clock.now() - start;
    })();
    const elapsed = await clock.runUntil(work);
    expect(elapsed).toBeGreaterThanOrEqual(20);
    expect(elapsed).toBeLessThanOrEqual(60);
  });

  it("fails every admitted request at faultRate 1 and none at 0", async () => {
    for (const [faultRate, expected] of [
      [1, 503],
      [0, 200],
    ] as const) {
      const clock = new VirtualClock();
      const api = new SimulatedApi(clock, createRng(5), makeOpts({ faultRate }));
      const res = await clock.runUntil(api.request());
      expect(res.status).toBe(expected);
    }
  });

  it("counts peak arrivals per window and rejects a non-positive window", async () => {
    const clock = new VirtualClock();
    const api = new SimulatedApi(clock, createRng(1), makeOpts({ burst: 10 }));
    const work = (async () => {
      await Promise.all([api.request(), api.request(), api.request()]);
      await clock.sleep(500);
      await api.request();
    })();
    await clock.runUntil(work);
    expect(api.peakArrivalsPerWindow(100)).toBe(3);
    expect(() => api.peakArrivalsPerWindow(0)).toThrow(/windowMs/);
  });
});
