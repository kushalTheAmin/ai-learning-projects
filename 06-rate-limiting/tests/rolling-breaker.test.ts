import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "../src/breaker.js";
import { VirtualClock } from "../src/clock.js";
import { RollingWindowBreaker, type RollingBreakerOptions } from "../src/rolling-breaker.js";

const OPTS: RollingBreakerOptions = { windowMs: 1_000, errorRateThreshold: 0.5, minVolume: 4, openMs: 2_000 };

function make(clock: VirtualClock, overrides: Partial<RollingBreakerOptions> = {}): RollingWindowBreaker {
  return new RollingWindowBreaker(clock, { ...OPTS, ...overrides });
}

/** Settle one non-probe outcome through the acquire/settle contract. */
function settleOne(breaker: RollingWindowBreaker | CircuitBreaker, ok: boolean): void {
  const gate = breaker.tryAcquire();
  if (!gate.admitted) throw new Error("expected admission");
  breaker.settle(gate, ok);
}

describe("RollingWindowBreaker options", () => {
  it("rejects bad windows, thresholds, volumes, and cooldowns", () => {
    const clock = new VirtualClock();
    expect(() => make(clock, { windowMs: 0 })).toThrow(/windowMs/);
    expect(() => make(clock, { windowMs: Number.POSITIVE_INFINITY })).toThrow(/windowMs/);
    expect(() => make(clock, { errorRateThreshold: 0 })).toThrow(/errorRateThreshold/);
    expect(() => make(clock, { errorRateThreshold: 1.01 })).toThrow(/errorRateThreshold/);
    expect(() => make(clock, { errorRateThreshold: Number.NaN })).toThrow(/errorRateThreshold/);
    expect(() => make(clock, { minVolume: 0 })).toThrow(/minVolume/);
    expect(() => make(clock, { minVolume: 2.5 })).toThrow(/minVolume/);
    expect(() => make(clock, { openMs: -1 })).toThrow(/openMs/);
  });
});

describe("RollingWindowBreaker tripping", () => {
  it("never trips below the volume floor, even at 100% failure", () => {
    const clock = new VirtualClock();
    const b = make(clock, { minVolume: 5 });
    for (let i = 0; i < 4; i++) settleOne(b, false);
    expect(b.state()).toBe("closed");
    expect(b.trips).toBe(0);
    expect(b.windowVolume()).toBe(4);
    expect(b.windowFailures()).toBe(4);
  });

  it("trips on the settle that meets both volume and rate", () => {
    const clock = new VirtualClock();
    const b = make(clock, { minVolume: 4 });
    settleOne(b, false);
    settleOne(b, false);
    settleOne(b, false);
    expect(b.state()).toBe("closed");
    settleOne(b, false);
    expect(b.state()).toBe("open");
    expect(b.trips).toBe(1);
    expect(b.tryAcquire()).toEqual({ admitted: false });
    expect(b.rejections).toBe(1);
  });

  it("a rate exactly at the threshold trips; just under does not", () => {
    const clock = new VirtualClock();
    const under = make(clock, { minVolume: 10 });
    for (let i = 0; i < 6; i++) settleOne(under, true);
    for (let i = 0; i < 4; i++) settleOne(under, false);
    expect(under.state()).toBe("closed"); // 4/10 < 0.5
    const at = make(clock, { minVolume: 10 });
    for (let i = 0; i < 5; i++) settleOne(at, true);
    for (let i = 0; i < 5; i++) settleOne(at, false);
    expect(at.state()).toBe("open"); // 5/10 >= 0.5
  });

  it("successes dilute instead of resetting: a spaced failure pattern still trips", () => {
    const clock = new VirtualClock();
    const rolling = make(clock, { minVolume: 4, errorRateThreshold: 0.6 });
    const counter = new CircuitBreaker(clock, { failureThreshold: 3, openMs: 2_000 });
    // F F ok F: never 3 consecutive, but 3 of 4 = 0.75 >= 0.6.
    for (const ok of [false, false, true, false]) {
      settleOne(rolling, ok);
      settleOne(counter, ok);
    }
    expect(counter.state()).toBe("closed");
    expect(rolling.state()).toBe("open");
  });

  it("one worker's streak diluted by the herd trips the counter, not the rate", () => {
    const clock = new VirtualClock();
    const rolling = make(clock, { minVolume: 10, errorRateThreshold: 0.5 });
    const counter = new CircuitBreaker(clock, { failureThreshold: 5, openMs: 2_000 });
    // 15 interleaved successes, then one worker's 5-failure streak lands in a
    // row: 5/20 = 0.25 in the window, but 5 consecutive on the counter.
    for (let i = 0; i < 15; i++) {
      settleOne(rolling, true);
      settleOne(counter, true);
    }
    for (let i = 0; i < 5; i++) {
      settleOne(rolling, false);
      settleOne(counter, false);
    }
    expect(counter.state()).toBe("open");
    expect(rolling.state()).toBe("closed");
    expect(rolling.windowVolume()).toBe(20);
    expect(rolling.windowFailures()).toBe(5);
  });

  it("evicts settles older than the window, boundary inclusive", async () => {
    const clock = new VirtualClock();
    const b = make(clock, { minVolume: 3, windowMs: 1_000 });
    settleOne(b, false);
    settleOne(b, false);
    await clock.runUntil(clock.sleep(1_000)); // entries at t=0 now sit exactly at the cutoff
    expect(b.windowVolume()).toBe(0);
    settleOne(b, false);
    expect(b.state()).toBe("closed"); // only 1 in window: old failures aged out
    expect(b.windowVolume()).toBe(1);
    expect(b.windowFailures()).toBe(1);
  });

  it("keeps settles strictly inside the window", async () => {
    const clock = new VirtualClock();
    const b = make(clock, { minVolume: 3, windowMs: 1_000 });
    settleOne(b, false);
    settleOne(b, false);
    await clock.runUntil(clock.sleep(999));
    settleOne(b, false); // 3 failures in window, 3/3 >= 0.5
    expect(b.state()).toBe("open");
  });
});

describe("RollingWindowBreaker gate machinery", () => {
  async function tripped(clock: VirtualClock): Promise<RollingWindowBreaker> {
    const b = make(clock, { minVolume: 4 });
    for (let i = 0; i < 4; i++) settleOne(b, false);
    expect(b.state()).toBe("open");
    return b;
  }

  it("cooldown, then a single probe; success closes with an empty window", async () => {
    const clock = new VirtualClock();
    const b = await tripped(clock);
    expect(b.tryAcquire()).toEqual({ admitted: false });
    expect(b.msUntilProbe()).toBe(2_000);
    await clock.runUntil(clock.sleep(2_000));
    expect(b.state()).toBe("half-open");
    const probe = b.tryAcquire();
    expect(probe).toEqual({ admitted: true, probe: true });
    expect(b.tryAcquire()).toEqual({ admitted: false }); // probe slot taken
    b.settle({ probe: true }, true);
    expect(b.state()).toBe("closed");
    expect(b.windowVolume()).toBe(0);
    // Re-tripping needs fresh volume: 3 straight failures are not enough.
    for (let i = 0; i < 3; i++) settleOne(b, false);
    expect(b.state()).toBe("closed");
    settleOne(b, false);
    expect(b.state()).toBe("open");
    expect(b.trips).toBe(2);
  });

  it("probe failure restarts the cooldown", async () => {
    const clock = new VirtualClock();
    const b = await tripped(clock);
    await clock.runUntil(clock.sleep(2_000));
    const probe = b.tryAcquire();
    expect(probe).toEqual({ admitted: true, probe: true });
    b.settle({ probe: true }, false);
    expect(b.state()).toBe("open");
    expect(b.msUntilProbe()).toBe(2_000);
    expect(b.probes).toBe(1);
  });

  it("ignores stragglers that settle while open", async () => {
    const clock = new VirtualClock();
    const b = await tripped(clock);
    b.settle({ probe: false }, false); // straggler admitted before the trip
    await clock.runUntil(clock.sleep(2_000));
    b.settle(b.tryAcquire() as { admitted: true; probe: boolean }, true);
    expect(b.state()).toBe("closed");
    expect(b.windowVolume()).toBe(0); // the straggler left no evidence behind
  });

  it("throws on settling a probe it did not admit", () => {
    const clock = new VirtualClock();
    const b = make(clock);
    expect(() => b.settle({ probe: true }, true)).toThrow(/did not admit/);
  });

  it("msUntilProbe is 0 while closed", () => {
    const clock = new VirtualClock();
    expect(make(clock).msUntilProbe()).toBe(0);
  });
});
