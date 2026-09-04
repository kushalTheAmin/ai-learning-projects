import { describe, expect, it } from "vitest";
import { AimdPacer, type AimdOptions } from "../src/adaptive.js";
import { VirtualClock } from "../src/clock.js";

function makeOpts(overrides: Partial<AimdOptions> = {}): AimdOptions {
  return {
    initialRatePerSec: 10,
    minRatePerSec: 1,
    maxRatePerSec: 100,
    increasePerSec: 5,
    decreaseFactor: 0.5,
    holdOffMs: 1000,
    burst: 1,
    ...overrides,
  };
}

describe("AimdPacer", () => {
  it("rejects malformed options", () => {
    const clock = new VirtualClock();
    expect(() => new AimdPacer(makeOpts({ minRatePerSec: 0 }), clock)).toThrow(/minRatePerSec/);
    expect(() => new AimdPacer(makeOpts({ maxRatePerSec: 0.5 }), clock)).toThrow(/maxRatePerSec/);
    expect(() => new AimdPacer(makeOpts({ initialRatePerSec: 200 }), clock)).toThrow(/initialRatePerSec/);
    expect(() => new AimdPacer(makeOpts({ initialRatePerSec: 0.5 }), clock)).toThrow(/initialRatePerSec/);
    expect(() => new AimdPacer(makeOpts({ increasePerSec: 0 }), clock)).toThrow(/increasePerSec/);
    expect(() => new AimdPacer(makeOpts({ decreaseFactor: 1 }), clock)).toThrow(/decreaseFactor/);
    expect(() => new AimdPacer(makeOpts({ decreaseFactor: 0 }), clock)).toThrow(/decreaseFactor/);
    expect(() => new AimdPacer(makeOpts({ holdOffMs: -1 }), clock)).toThrow(/holdOffMs/);
  });

  it("grows the rate additively with clock time, capped at max", async () => {
    const clock = new VirtualClock();
    const pacer = new AimdPacer(makeOpts(), clock); // 10 + 5/s
    const work = (async () => {
      await clock.sleep(2000);
      const atTwo = pacer.currentRatePerSec();
      await clock.sleep(60_000);
      return [atTwo, pacer.currentRatePerSec()];
    })();
    const [atTwo, later] = await clock.runUntil(work);
    expect(atTwo).toBeCloseTo(20); // 10 + 2 * 5
    expect(later).toBe(100); // capped at max
  });

  it("cuts multiplicatively on 429 and clamps at min", async () => {
    const clock = new VirtualClock();
    const pacer = new AimdPacer(makeOpts({ holdOffMs: 0 }), clock);
    const work = (async () => {
      await clock.sleep(2000); // rate 20
      pacer.on429();
      const afterOne = pacer.currentRatePerSec();
      for (let i = 0; i < 20; i++) pacer.on429();
      return [afterOne, pacer.currentRatePerSec()];
    })();
    const [afterOne, floor] = await clock.runUntil(work);
    expect(afterOne).toBeCloseTo(10); // 20 * 0.5
    expect(floor).toBe(1); // clamped at minRatePerSec
    expect(pacer.cuts).toBe(21);
  });

  it("treats 429s inside the hold-off window as one congestion event", async () => {
    const clock = new VirtualClock();
    const pacer = new AimdPacer(makeOpts({ increasePerSec: 0.001, holdOffMs: 1000 }), clock);
    const work = (async () => {
      pacer.on429(); // 10 -> 5
      pacer.on429(); // ignored: same event
      pacer.on429(); // ignored
      const inside = pacer.currentRatePerSec();
      await clock.sleep(1000);
      pacer.on429(); // new event: ~5 -> ~2.5
      return [inside, pacer.currentRatePerSec()];
    })();
    const [inside, afterWindow] = await clock.runUntil(work);
    expect(inside).toBeCloseTo(5, 1);
    expect(afterWindow).toBeCloseTo(2.5, 1);
    expect(pacer.cuts).toBe(2);
  });

  it("a cut resets the growth anchor instead of banking pre-cut growth", async () => {
    const clock = new VirtualClock();
    const pacer = new AimdPacer(makeOpts({ holdOffMs: 0 }), clock);
    const work = (async () => {
      await clock.sleep(4000); // 10 + 4*5 = 30
      pacer.on429(); // -> 15, anchor reset here
      await clock.sleep(1000);
      return pacer.currentRatePerSec();
    })();
    const rate = await clock.runUntil(work);
    expect(rate).toBeCloseTo(20); // 15 + 1*5, not 15 + 5*5
  });

  it("paces grants at the live rate: gaps shrink as the rate grows", async () => {
    const clock = new VirtualClock();
    // Start slow and grow fast so consecutive grant gaps must shrink.
    const pacer = new AimdPacer(
      makeOpts({ initialRatePerSec: 2, increasePerSec: 20, maxRatePerSec: 1000 }),
      clock,
    );
    const grantTimes: number[] = [];
    const work = (async () => {
      for (let i = 0; i < 8; i++) {
        await pacer.acquire();
        grantTimes.push(clock.now());
      }
    })();
    await clock.runUntil(work);
    expect(grantTimes).toHaveLength(8);
    const gaps: number[] = [];
    for (let i = 2; i < grantTimes.length; i++) {
      gaps.push(grantTimes[i]! - grantTimes[i - 1]!);
    }
    for (let i = 1; i < gaps.length; i++) {
      expect(gaps[i]!).toBeLessThanOrEqual(gaps[i - 1]!);
    }
    expect(gaps[gaps.length - 1]!).toBeLessThan(gaps[0]!);
  });

  it("reading the rate does not advance the pacer: sampled and unsampled grants match", async () => {
    // currentRatePerSec is a diagnostic read. If it commits growth to the
    // token bucket, sampling the rate accrues tokens on a different path than
    // not sampling it, and the trace changes the run it is supposed to watch.
    const grantsWith: number[] = [];
    const grantsWithout: number[] = [];
    const sampledRates: number[] = [];
    for (const [sample, grants] of [
      [true, grantsWith],
      [false, grantsWithout],
    ] as const) {
      const clock = new VirtualClock();
      const pacer = new AimdPacer(
        makeOpts({ initialRatePerSec: 2, increasePerSec: 20, maxRatePerSec: 1000, burst: 2 }),
        clock,
      );
      let sampling = true;
      if (sample) {
        void (async () => {
          while (sampling) {
            sampledRates.push(pacer.currentRatePerSec());
            await clock.sleep(20);
          }
        })();
      }
      const work = (async () => {
        for (let i = 0; i < 10; i++) {
          await pacer.acquire();
          grants.push(clock.now());
        }
      })().finally(() => {
        sampling = false;
      });
      await clock.runUntil(work);
    }
    expect(grantsWith).toHaveLength(10);
    expect(sampledRates.length).toBeGreaterThan(3);
    expect(grantsWith).toEqual(grantsWithout);
  });

  it("a cut while waiters sleep stretches their remaining wait", async () => {
    const clock = new VirtualClock();
    const pacer = new AimdPacer(
      makeOpts({ initialRatePerSec: 10, increasePerSec: 0.001, holdOffMs: 0 }),
      clock,
    );
    const grantTimes: number[] = [];
    const work = (async () => {
      await pacer.acquire(); // burst token at t=0
      const second = pacer.acquire().then(() => grantTimes.push(clock.now()));
      await clock.sleep(50);
      pacer.on429(); // 10 -> ~5: the pending grant now needs ~200ms total
      await second;
    })();
    await clock.runUntil(work);
    expect(grantTimes).toHaveLength(1);
    // Without the cut the grant lands at t=100; halving the rate at t=50
    // stretches the remaining half token to 100ms more.
    expect(grantTimes[0]!).toBeGreaterThanOrEqual(150);
  });
});
