import { describe, expect, it } from "vitest";
import { BoundedQueue, runBackpressureExperiment } from "../src/backpressure.js";

async function drain<T>(queue: BoundedQueue<T>): Promise<T[]> {
  const out: T[] = [];
  for (;;) {
    const result = await queue.pop();
    if (result.done) return out;
    out.push(result.value);
  }
}

describe("BoundedQueue", () => {
  it("rejects capacity < 1", () => {
    expect(() => new BoundedQueue(0)).toThrow();
  });

  it("delivers items in FIFO order", async () => {
    const queue = new BoundedQueue<number>(Infinity);
    for (let i = 0; i < 100; i++) await queue.push(i);
    queue.close();
    expect(await drain(queue)).toEqual(Array.from({ length: 100 }, (_, i) => i));
  });

  it("close with an empty queue ends waiting and future pops", async () => {
    const queue = new BoundedQueue<number>(4);
    const waiting = queue.pop();
    queue.close();
    expect(await waiting).toEqual({ done: true });
    expect(await queue.pop()).toEqual({ done: true });
  });

  it("drains buffered items after close before reporting done", async () => {
    const queue = new BoundedQueue<number>(4);
    await queue.push(1);
    await queue.push(2);
    queue.close();
    expect(await drain(queue)).toEqual([1, 2]);
  });

  it("throws on push after close", async () => {
    const queue = new BoundedQueue<number>(1);
    queue.close();
    await expect(async () => queue.push(1)).rejects.toThrow("push after close");
  });

  it("blocks the producer at capacity and resumes it on pop", async () => {
    const queue = new BoundedQueue<string>(2);
    await queue.push("a");
    await queue.push("b");
    let third = false;
    const blocked = queue.push("c").then(() => {
      third = true;
    });
    await Promise.resolve();
    expect(third).toBe(false);
    expect(queue.blockedPushes).toBe(1);

    expect(await queue.pop()).toEqual({ done: false, value: "a" });
    await blocked;
    expect(third).toBe(true);
    queue.close();
    expect(await drain(queue)).toEqual(["b", "c"]);
  });

  it("hands items directly to a waiting consumer without buffering", async () => {
    const queue = new BoundedQueue<number>(1);
    const waiting = queue.pop();
    await queue.push(7);
    expect(await waiting).toEqual({ done: false, value: 7 });
    expect(queue.peakLength).toBe(0);
  });

  it("keeps order with a full producer/consumer overlap", async () => {
    const queue = new BoundedQueue<number>(3);
    const n = 500;
    const producer = (async () => {
      for (let i = 0; i < n; i++) await queue.push(i);
      queue.close();
    })();
    const consumed = await drain(queue);
    await producer;
    expect(consumed).toEqual(Array.from({ length: n }, (_, i) => i));
    expect(queue.peakLength).toBeLessThanOrEqual(3);
  });

  it("handles a single-item queue end to end", async () => {
    const queue = new BoundedQueue<number>(1);
    const producer = (async () => {
      for (let i = 0; i < 10; i++) await queue.push(i);
      queue.close();
    })();
    expect(await drain(queue)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    await producer;
    expect(queue.peakLength).toBeLessThanOrEqual(1);
  });
});

describe("runBackpressureExperiment", () => {
  const chunks = Array.from({ length: 200 }, () => new Uint8Array(64));

  it("unbounded queue buffers the producer's entire burst", async () => {
    const report = await runBackpressureExperiment("unbounded", chunks, Infinity);
    expect(report.itemsProcessed).toBe(200);
    // The producer never awaits room, so nearly everything piles up.
    expect(report.peakBufferedItems).toBeGreaterThan(150);
    expect(report.blockedPushes).toBe(0);
  });

  it("bounded channel caps the buffer at its capacity", async () => {
    const report = await runBackpressureExperiment("bounded", chunks, 8);
    expect(report.itemsProcessed).toBe(200);
    expect(report.peakBufferedItems).toBeLessThanOrEqual(8);
    expect(report.blockedPushes).toBeGreaterThan(0);
  });
});
