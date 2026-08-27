import { describe, expect, it } from "vitest";
import { VirtualClock } from "../../06-rate-limiting/src/clock.js";
import { Semaphore } from "../src/semaphore.js";

describe("Semaphore", () => {
  it("rejects a non-positive or fractional limit", () => {
    expect(() => new Semaphore(0)).toThrow(/positive integer/);
    expect(() => new Semaphore(-1)).toThrow(/positive integer/);
    expect(() => new Semaphore(1.5)).toThrow(/positive integer/);
  });

  it("serves waiters strictly in arrival order", async () => {
    const sem = new Semaphore(1);
    const first = await sem.acquire();
    const order: number[] = [];
    const p2 = sem.acquire().then((release) => {
      order.push(2);
      return release;
    });
    const p3 = sem.acquire().then((release) => {
      order.push(3);
      return release;
    });
    expect(sem.waiting()).toBe(2);
    first();
    const second = await p2;
    second();
    const third = await p3;
    third();
    expect(order).toEqual([2, 3]);
    expect(sem.inUse()).toBe(0);
    expect(sem.waiting()).toBe(0);
  });

  it("never lets more than `limit` holders run at once", async () => {
    const clock = new VirtualClock();
    const sem = new Semaphore(2);
    let active = 0;
    let maxActive = 0;
    const run = Promise.all(
      Array.from({ length: 7 }, () =>
        sem.withPermit(async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await clock.sleep(10);
          active--;
        }),
      ),
    );
    await clock.runUntil(run);
    expect(maxActive).toBe(2);
    expect(sem.highWater()).toBe(2);
    expect(sem.maxQueue()).toBe(5);
  });

  it("releases the permit when the guarded function throws", async () => {
    const sem = new Semaphore(1);
    await expect(
      sem.withPermit(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(sem.inUse()).toBe(0);
    await sem.withPermit(async () => {});
  });

  it("throws on a double release instead of inflating the limit", async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    release();
    expect(() => release()).toThrow(/released twice/);
    expect(sem.inUse()).toBe(0);
  });

  it("a released permit handed to a waiter cannot be released again by the old holder", async () => {
    const sem = new Semaphore(1);
    const first = await sem.acquire();
    const p2 = sem.acquire();
    first();
    const second = await p2;
    expect(() => first()).toThrow(/released twice/);
    expect(sem.inUse()).toBe(1);
    second();
    expect(sem.inUse()).toBe(0);
  });
});
