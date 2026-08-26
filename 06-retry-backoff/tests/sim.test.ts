import { describe, expect, it } from "vitest";
import { Simulation } from "../src/sim.js";

describe("Simulation", () => {
  it("runs events in time order regardless of scheduling order", () => {
    const sim = new Simulation();
    const order: number[] = [];
    sim.schedule(3, () => order.push(3));
    sim.schedule(1, () => order.push(1));
    sim.schedule(2, () => order.push(2));
    sim.run();
    expect(order).toEqual([1, 2, 3]);
  });

  it("breaks time ties by insertion order (FIFO)", () => {
    const sim = new Simulation();
    const order: string[] = [];
    for (const label of ["a", "b", "c", "d", "e"]) {
      sim.schedule(5, () => order.push(label));
    }
    sim.run();
    expect(order).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("advances the clock to each event's time", () => {
    const sim = new Simulation();
    const seen: number[] = [];
    sim.schedule(1.5, () => seen.push(sim.now));
    sim.schedule(4, () => seen.push(sim.now));
    sim.run();
    expect(seen).toEqual([1.5, 4]);
  });

  it("supports scheduling from inside a running event, relative to now", () => {
    const sim = new Simulation();
    const seen: number[] = [];
    sim.schedule(2, () => {
      sim.schedule(3, () => seen.push(sim.now));
    });
    sim.run();
    expect(seen).toEqual([5]);
  });

  it("handles zero-delay chains without losing progress", () => {
    const sim = new Simulation();
    let count = 0;
    const tick = (): void => {
      count++;
      if (count < 100) sim.schedule(0, tick);
    };
    sim.schedule(0, tick);
    sim.run();
    expect(count).toBe(100);
    expect(sim.now).toBe(0);
  });

  it("rejects negative, NaN, and infinite delays", () => {
    const sim = new Simulation();
    expect(() => sim.schedule(-1, () => {})).toThrow(RangeError);
    expect(() => sim.schedule(Number.NaN, () => {})).toThrow(RangeError);
    expect(() => sim.schedule(Number.POSITIVE_INFINITY, () => {})).toThrow(RangeError);
  });

  it("run on an empty simulation is a no-op", () => {
    const sim = new Simulation();
    sim.run();
    expect(sim.now).toBe(0);
    expect(sim.pendingCount).toBe(0);
  });

  it("keeps ordering under a large interleaved load", () => {
    const sim = new Simulation();
    const times: number[] = [];
    // Adversarial insertion order: descending, then ascending, then ties.
    for (let i = 999; i >= 0; i--) sim.schedule(i, () => times.push(sim.now));
    for (let i = 0; i < 1000; i++) sim.schedule(i + 0.5, () => times.push(sim.now));
    sim.run();
    const sorted = [...times].sort((a, b) => a - b);
    expect(times).toEqual(sorted);
    expect(times).toHaveLength(2000);
  });
});
