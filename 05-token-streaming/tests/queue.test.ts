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

describe("byte-budgeted AsyncQueue", () => {
  const byteLength = (chunk: Uint8Array) => chunk.byteLength;

  it("admits up to the byte budget exactly, then blocks", async () => {
    const queue = new AsyncQueue<Uint8Array>({ maxBytes: 10, sizeOf: byteLength });
    await queue.push(new Uint8Array(6));
    // 6 + 4 fills the budget exactly and must not block
    await queue.push(new Uint8Array(4));
    expect(queue.bufferedBytes).toBe(10);
    let accepted = false;
    const pending = queue.push(new Uint8Array(1)).then(() => {
      accepted = true;
    });
    await tick();
    expect(accepted).toBe(false);
    expect(queue.stats.stalledPushes).toBe(1);

    const iterator = queue[Symbol.asyncIterator]();
    expect((await iterator.next()).value.byteLength).toBe(6);
    await pending;
    expect(accepted).toBe(true);
    expect(queue.bufferedBytes).toBe(5);
  });

  it("admits several waiting small pushes on one large drain", async () => {
    const queue = new AsyncQueue<Uint8Array>({ maxBytes: 30, sizeOf: byteLength });
    await queue.push(new Uint8Array(25));
    const settled = [false, false, false];
    const pendings = settled.map((_, i) =>
      queue.push(new Uint8Array(10)).then(() => {
        settled[i] = true;
      }),
    );
    await tick();
    expect(settled).toEqual([false, false, false]);

    const iterator = queue[Symbol.asyncIterator]();
    expect((await iterator.next()).value.byteLength).toBe(25);
    await Promise.all(pendings);
    // all three 10-byte items fit the freed 30-byte budget together
    expect(settled).toEqual([true, true, true]);
    expect(queue.bufferedBytes).toBe(30);
  });

  it("keeps FIFO order: a small pusher cannot jump an earlier oversized one", async () => {
    const queue = new AsyncQueue<Uint8Array>({ maxBytes: 16, sizeOf: byteLength });
    await queue.push(new Uint8Array(10));
    void queue.push(new Uint8Array(100));
    // 10 + 5 would fit, but the 100-byte push is ahead in line
    void queue.push(new Uint8Array(5));
    await tick();

    queue.close();
    const sizes: number[] = [];
    for await (const chunk of queue) sizes.push(chunk.byteLength);
    expect(sizes).toEqual([10, 100, 5]);
  });

  it("admits an item larger than the whole budget into an empty buffer instead of deadlocking", async () => {
    const queue = new AsyncQueue<Uint8Array>({ maxBytes: 16, sizeOf: byteLength });
    await queue.push(new Uint8Array(100));
    expect(queue.stats.oversizedPushes).toBe(1);
    expect(queue.stats.sizeHighWaterMark).toBe(100);
    queue.close();
    const sizes: number[] = [];
    for await (const chunk of queue) sizes.push(chunk.byteLength);
    expect(sizes).toEqual([100]);
  });

  it("counts zero-size items against maxItems but never against maxBytes", async () => {
    const unbounded = new AsyncQueue<Uint8Array>({ maxBytes: 1, sizeOf: () => 0 });
    for (let i = 0; i < 50; i++) await unbounded.push(new Uint8Array(0));
    expect(unbounded.stats.highWaterMark).toBe(50);
    expect(unbounded.stats.stalledPushes).toBe(0);

    const capped = new AsyncQueue<Uint8Array>({ maxItems: 3, maxBytes: 1, sizeOf: () => 0 });
    for (let i = 0; i < 3; i++) await capped.push(new Uint8Array(0));
    let accepted = false;
    void capped.push(new Uint8Array(0)).then(() => {
      accepted = true;
    });
    await tick();
    expect(accepted).toBe(false);
  });

  it("applies whichever cap binds first when both are set", async () => {
    const itemBound = new AsyncQueue<Uint8Array>({ maxItems: 2, maxBytes: 100, sizeOf: byteLength });
    await itemBound.push(new Uint8Array(10));
    await itemBound.push(new Uint8Array(10));
    let acceptedByItems = false;
    void itemBound.push(new Uint8Array(10)).then(() => {
      acceptedByItems = true;
    });
    await tick();
    expect(acceptedByItems).toBe(false);

    const byteBound = new AsyncQueue<Uint8Array>({ maxItems: 10, maxBytes: 15, sizeOf: byteLength });
    await byteBound.push(new Uint8Array(10));
    let acceptedByBytes = false;
    void byteBound.push(new Uint8Array(10)).then(() => {
      acceptedByBytes = true;
    });
    await tick();
    expect(acceptedByBytes).toBe(false);
  });

  it("rejects a sizeOf result that is negative or not finite", async () => {
    const negative = new AsyncQueue<number>({ maxBytes: 10, sizeOf: () => -1 });
    await expect(negative.push(1)).rejects.toThrow(TypeError);
    const nan = new AsyncQueue<number>({ maxBytes: 10, sizeOf: () => NaN });
    await expect(nan.push(1)).rejects.toThrow(TypeError);
  });

  it("validates the options form", () => {
    expect(() => new AsyncQueue<number>({ maxBytes: 8 })).toThrow(TypeError);
    expect(() => new AsyncQueue<number>({ maxBytes: 0, sizeOf: () => 1 })).toThrow(RangeError);
    expect(() => new AsyncQueue<number>({ maxItems: 0 })).toThrow(RangeError);
  });

  it("keeps the positional form's sizeOf as statistics only", async () => {
    const queue = new AsyncQueue<Uint8Array>(3, byteLength);
    for (let i = 0; i < 3; i++) await queue.push(new Uint8Array(1000));
    // never blocked: 3000 buffered bytes are measured, not enforced
    expect(queue.stats.stalledPushes).toBe(0);
    expect(queue.stats.sizeHighWaterMark).toBe(3000);
  });
});
