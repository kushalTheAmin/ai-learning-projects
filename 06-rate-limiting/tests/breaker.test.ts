import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "../src/breaker.js";
import { VirtualClock } from "../src/clock.js";

function admitted(breaker: CircuitBreaker): { probe: boolean } {
  const gate = breaker.tryAcquire();
  if (!gate.admitted) throw new Error("expected the breaker to admit");
  return gate;
}

describe("CircuitBreaker", () => {
  it("rejects a non-positive or fractional failure threshold", () => {
    const clock = new VirtualClock();
    expect(() => new CircuitBreaker(clock, { failureThreshold: 0, openMs: 100 })).toThrow(/failureThreshold/);
    expect(() => new CircuitBreaker(clock, { failureThreshold: 2.5, openMs: 100 })).toThrow(/failureThreshold/);
  });

  it("rejects a negative or non-finite cooldown", () => {
    const clock = new VirtualClock();
    expect(() => new CircuitBreaker(clock, { failureThreshold: 1, openMs: -1 })).toThrow(/openMs/);
    expect(() => new CircuitBreaker(clock, { failureThreshold: 1, openMs: Number.POSITIVE_INFINITY })).toThrow(/openMs/);
  });

  it("stays closed below the threshold and admits everyone", () => {
    const clock = new VirtualClock();
    const breaker = new CircuitBreaker(clock, { failureThreshold: 3, openMs: 100 });
    breaker.settle(admitted(breaker), false);
    breaker.settle(admitted(breaker), false);
    expect(breaker.state()).toBe("closed");
    expect(breaker.trips).toBe(0);
  });

  it("trips open at exactly the threshold of consecutive failures", () => {
    const clock = new VirtualClock();
    const breaker = new CircuitBreaker(clock, { failureThreshold: 3, openMs: 100 });
    for (let i = 0; i < 3; i++) breaker.settle(admitted(breaker), false);
    expect(breaker.state()).toBe("open");
    expect(breaker.trips).toBe(1);
    expect(breaker.tryAcquire()).toEqual({ admitted: false });
    expect(breaker.rejections).toBe(1);
  });

  it("resets the streak on a counted success, so non-consecutive failures never trip", () => {
    const clock = new VirtualClock();
    const breaker = new CircuitBreaker(clock, { failureThreshold: 2, openMs: 100 });
    for (let i = 0; i < 5; i++) {
      breaker.settle(admitted(breaker), false);
      breaker.settle(admitted(breaker), true);
    }
    expect(breaker.state()).toBe("closed");
    expect(breaker.trips).toBe(0);
  });

  it("trips with threshold 1 on the first failure", () => {
    const clock = new VirtualClock();
    const breaker = new CircuitBreaker(clock, { failureThreshold: 1, openMs: 100 });
    breaker.settle(admitted(breaker), false);
    expect(breaker.state()).toBe("open");
  });

  it("reports the time left until a probe and goes half-open when it elapses", async () => {
    const clock = new VirtualClock();
    const breaker = new CircuitBreaker(clock, { failureThreshold: 1, openMs: 100 });
    breaker.settle(admitted(breaker), false);
    expect(breaker.msUntilProbe()).toBe(100);
    await clock.runUntil(clock.sleep(99));
    expect(breaker.state()).toBe("open");
    expect(breaker.msUntilProbe()).toBe(1);
    await clock.runUntil(clock.sleep(1));
    expect(breaker.state()).toBe("half-open");
    expect(breaker.msUntilProbe()).toBe(0);
  });

  it("admits exactly one probe while half-open", async () => {
    const clock = new VirtualClock();
    const breaker = new CircuitBreaker(clock, { failureThreshold: 1, openMs: 100 });
    breaker.settle(admitted(breaker), false);
    await clock.runUntil(clock.sleep(100));
    const gate = breaker.tryAcquire();
    expect(gate).toEqual({ admitted: true, probe: true });
    expect(breaker.tryAcquire()).toEqual({ admitted: false });
    expect(breaker.probes).toBe(1);
  });

  it("closes on a successful probe and forgets the failure streak", async () => {
    const clock = new VirtualClock();
    const breaker = new CircuitBreaker(clock, { failureThreshold: 2, openMs: 100 });
    breaker.settle(admitted(breaker), false);
    breaker.settle(admitted(breaker), false);
    await clock.runUntil(clock.sleep(100));
    breaker.settle(admitted(breaker), true);
    expect(breaker.state()).toBe("closed");
    // A fresh streak is needed to trip again: one failure is not enough.
    breaker.settle(admitted(breaker), false);
    expect(breaker.state()).toBe("closed");
  });

  it("restarts the cooldown from the probe's failure, not the original trip", async () => {
    const clock = new VirtualClock();
    const breaker = new CircuitBreaker(clock, { failureThreshold: 1, openMs: 100 });
    breaker.settle(admitted(breaker), false); // trips at t=0
    await clock.runUntil(clock.sleep(150));
    breaker.settle(admitted(breaker), false); // probe fails at t=150
    expect(breaker.state()).toBe("open");
    expect(breaker.msUntilProbe()).toBe(100);
    expect(breaker.trips).toBe(1); // a failed probe is a restarted cooldown, not a new trip
  });

  it("ignores straggler results while open", async () => {
    const clock = new VirtualClock();
    const breaker = new CircuitBreaker(clock, { failureThreshold: 2, openMs: 100 });
    const early = admitted(breaker); // admitted while closed, settles late
    breaker.settle(admitted(breaker), false);
    breaker.settle(admitted(breaker), false); // trips
    await clock.runUntil(clock.sleep(50));
    breaker.settle(early, false); // straggler failure must not extend the cooldown
    expect(breaker.msUntilProbe()).toBe(50);
    breaker.settle({ probe: false }, true); // straggler success must not close it
    expect(breaker.state()).toBe("open");
  });

  it("throws when a probe is settled that was never admitted", () => {
    const clock = new VirtualClock();
    const breaker = new CircuitBreaker(clock, { failureThreshold: 1, openMs: 100 });
    expect(() => breaker.settle({ probe: true }, true)).toThrow(/probe/);
  });

  it("with openMs 0, a tripped breaker admits every next attempt as the probe", () => {
    const clock = new VirtualClock();
    const breaker = new CircuitBreaker(clock, { failureThreshold: 1, openMs: 0 });
    breaker.settle(admitted(breaker), false);
    const gate = breaker.tryAcquire();
    expect(gate).toEqual({ admitted: true, probe: true });
    if (!gate.admitted) throw new Error("unreachable");
    breaker.settle(gate, false);
    expect(breaker.tryAcquire()).toEqual({ admitted: true, probe: true });
  });
});
