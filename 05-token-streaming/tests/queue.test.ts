import { describe, expect, it } from "vitest";
import { AsyncQueue } from "../src/queue.js";

async function drain<T>(queue: AsyncQueue<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of queue) out.push(item);
  return out;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("AsyncQueue", () => {
  it("rejects a capacity below one", () => {
    expect(() => new AsyncQueue(0)).toThrow(RangeError);
  });

  it("preserves FIFO order", async () => {
    const queue = new AsyncQueue<number>(2);
    const producer = (async () => {
      for (let i = 0; i < 10; i++) await queue.push(i);
      queue.close();
    })();
    const items = await drain(queue);
    await producer;
    expect(items).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("blocks the producer while the buffer is full", async () => {
    const queue = new AsyncQueue<number>(1);
    await queue.push(1);
    let accepted = false;
    const pending = queue.push(2).then(() => {
      accepted = true;
    });
    await tick();
    expect(accepted).toBe(false);

    const iterator = queue[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toBe(1);
    await pending;
    expect(accepted).toBe(true);
    expect((await iterator.next()).value).toBe(2);
  });

  it("keeps the buffer high-water mark at or below capacity", async () => {
    const queue = new AsyncQueue<number>(3);
    const producer = (async () => {
      for (let i = 0; i < 50; i++) await queue.push(i);
      queue.close();
    })();
    const items: number[] = [];
    for await (const item of queue) {
      items.push(item);
      await tick();
    }
    await producer;
    expect(items).toHaveLength(50);
    expect(queue.stats.highWaterMark).toBeLessThanOrEqual(3);
    expect(queue.stats.stalledPushes).toBeGreaterThan(0);
  });

  it("grows without limit when unbounded", async () => {
    const queue = new AsyncQueue<number>();
    for (let i = 0; i < 100; i++) await queue.push(i);
    queue.close();
    expect(queue.stats.highWaterMark).toBe(100);
    expect(queue.stats.stalledPushes).toBe(0);
    expect(await drain(queue)).toHaveLength(100);
  });

  it("hands items straight to a waiting consumer", async () => {
    const queue = new AsyncQueue<string>(1);
    const iterator = queue[Symbol.asyncIterator]();
    const waiting = iterator.next();
    await queue.push("direct");
    expect((await waiting).value).toBe("direct");
    expect(queue.stats.highWaterMark).toBe(0);
  });

  it("drains buffered items after close, then ends iteration", async () => {
    const queue = new AsyncQueue<number>(5);
    await queue.push(1);
    await queue.push(2);
    queue.close();
    expect(await drain(queue)).toEqual([1, 2]);
  });

  it("wakes a waiting consumer on close with no items", async () => {
    const queue = new AsyncQueue<number>(1);
    const iterator = queue[Symbol.asyncIterator]();
    const waiting = iterator.next();
    queue.close();
    expect((await waiting).done).toBe(true);
  });

  it("rejects a push after close", async () => {
    const queue = new AsyncQueue<number>(1);
    queue.close();
    await expect(queue.push(1)).rejects.toThrow("push after close");
  });

  it("rejects undefined items", async () => {
    const queue = new AsyncQueue<number | undefined>(1);
    await expect(queue.push(undefined)).rejects.toThrow(TypeError);
  });

  it("measures buffered size from the actual items, not count times the largest one", async () => {
    // Sizes vary the way network chunks do; the answer is their sum, not
    // 7 * 24. Counting by the biggest possible chunk nearly doubles it here.
    const sizes = [1, 24, 2, 24, 3, 24, 1];
    const queue = new AsyncQueue<Uint8Array>(Infinity, (chunk) => chunk.byteLength);
    for (const size of sizes) await queue.push(new Uint8Array(size));
    queue.close();
    expect(queue.stats.highWaterMark).toBe(sizes.length);
    expect(queue.stats.sizeHighWaterMark).toBe(79);
    expect(await drain(queue)).toHaveLength(sizes.length);
  });

  it("tracks buffered size down as the consumer drains and back up as pending items land", async () => {
    const sizes = [10, 1, 20, 1, 30];
    const queue = new AsyncQueue<Uint8Array>(2, (chunk) => chunk.byteLength);
    const producer = (async () => {
      for (const size of sizes) await queue.push(new Uint8Array(size));
      queue.close();
    })();
    const seen: number[] = [];
    for await (const chunk of queue) {
      seen.push(chunk.byteLength);
      await tick();
    }
    await producer;
    expect(seen).toEqual(sizes);
    // capacity 2, so the buffer never holds more than the largest adjacent pair
    expect(queue.stats.sizeHighWaterMark).toBe(31);
  });

  it("reports zero buffered size when no size function is given", async () => {
    const queue = new AsyncQueue<number>(4);
    await queue.push(1);
    expect(queue.stats.sizeHighWaterMark).toBe(0);
  });
});
