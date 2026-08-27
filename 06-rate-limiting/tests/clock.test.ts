import { describe, expect, it } from "vitest";
import { VirtualClock } from "../src/clock.js";

describe("VirtualClock", () => {
  it("resolves sleeps in timestamp order and advances now()", async () => {
    const clock = new VirtualClock();
    const order: string[] = [];
    const work = Promise.all([
      clock.sleep(300).then(() => order.push(`c@${clock.now()}`)),
      clock.sleep(100).then(() => order.push(`a@${clock.now()}`)),
      clock.sleep(200).then(() => order.push(`b@${clock.now()}`)),
    ]);
    await clock.runUntil(work);
    expect(order).toEqual(["a@100", "b@200", "c@300"]);
    expect(clock.now()).toBe(300);
  });

  it("breaks timestamp ties in scheduling order", async () => {
    const clock = new VirtualClock();
    const order: number[] = [];
    const work = Promise.all([
      clock.sleep(50).then(() => order.push(1)),
      clock.sleep(50).then(() => order.push(2)),
      clock.sleep(50).then(() => order.push(3)),
    ]);
    await clock.runUntil(work);
    expect(order).toEqual([1, 2, 3]);
  });

  it("supports sleep(0) and nested sleeps scheduled from continuations", async () => {
    const clock = new VirtualClock();
    const marks: number[] = [];
    const work = clock.sleep(0).then(async () => {
      marks.push(clock.now());
      await clock.sleep(10);
      marks.push(clock.now());
    });
    await clock.runUntil(work);
    expect(marks).toEqual([0, 10]);
  });

  it("rejects negative and non-finite sleep durations", () => {
    const clock = new VirtualClock();
    expect(() => clock.sleep(-1)).toThrow(/non-negative/);
    expect(() => clock.sleep(Number.NaN)).toThrow(/non-negative/);
    expect(() => clock.sleep(Number.POSITIVE_INFINITY)).toThrow(/non-negative/);
  });

  it("throws on deadlock: pending work with nothing scheduled", async () => {
    const clock = new VirtualClock();
    const never = new Promise<void>(() => {});
    await expect(clock.runUntil(never)).rejects.toThrow(/deadlock/);
  });

  it("propagates rejections from the driven work", async () => {
    const clock = new VirtualClock();
    const work = clock.sleep(5).then(() => {
      throw new Error("boom");
    });
    await expect(clock.runUntil(work)).rejects.toThrow("boom");
  });
});
