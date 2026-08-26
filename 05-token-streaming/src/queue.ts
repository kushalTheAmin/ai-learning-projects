/**
 * Bounded async queue: the backpressure primitive between a fast producer
 * (the network) and a slow consumer (rendering, disk, a downstream API).
 *
 * `push` resolves immediately while the buffer has room and otherwise not
 * until the consumer frees a slot — so an `await queue.push(x)` producer is
 * paced by the consumer instead of buffering without limit. Consumption is
 * a plain `for await` loop. The queue records its own evidence: buffer
 * high-water mark and total time producers spent blocked.
 */

export interface QueueStats {
  highWaterMark: number;
  totalProducerStallMs: number;
  pushes: number;
  stalledPushes: number;
}

interface PendingPush<T> {
  item: T;
  resolve: () => void;
  enqueuedAt: number;
}

export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly pendingPushes: PendingPush<T>[] = [];
  private readonly takers: ((result: IteratorResult<T>) => void)[] = [];
  private closed = false;
  readonly stats: QueueStats = {
    highWaterMark: 0,
    totalProducerStallMs: 0,
    pushes: 0,
    stalledPushes: 0,
  };

  constructor(private readonly capacity: number = Infinity) {
    if (capacity < 1) throw new RangeError("capacity must be >= 1");
  }

  get size(): number {
    return this.items.length;
  }

  /** Resolves once the item is accepted; blocks while the buffer is full. */
  push(item: T): Promise<void> {
    if (item === undefined) {
      // undefined is the internal "buffer empty" sentinel and cannot be queued
      return Promise.reject(new TypeError("undefined items are not supported"));
    }
    if (this.closed) return Promise.reject(new Error("push after close"));
    this.stats.pushes++;
    const taker = this.takers.shift();
    if (taker !== undefined) {
      taker({ value: item, done: false });
      return Promise.resolve();
    }
    if (this.items.length < this.capacity) {
      this.items.push(item);
      this.stats.highWaterMark = Math.max(this.stats.highWaterMark, this.items.length);
      return Promise.resolve();
    }
    this.stats.stalledPushes++;
    return new Promise((resolve) => {
      this.pendingPushes.push({ item, resolve, enqueuedAt: performance.now() });
    });
  }

  /** No new pushes; buffered and pending items still drain to the consumer. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.items.length === 0 && this.pendingPushes.length === 0) {
      for (const taker of this.takers.splice(0)) {
        taker({ value: undefined, done: true });
      }
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const item = this.items.shift();
        if (item !== undefined) {
          this.admitPending();
          return Promise.resolve({ value: item, done: false });
        }
        const pending = this.pendingPushes.shift();
        if (pending !== undefined) {
          this.settlePending(pending);
          return Promise.resolve({ value: pending.item, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => this.takers.push(resolve));
      },
    };
  }

  private admitPending(): void {
    const pending = this.pendingPushes.shift();
    if (pending !== undefined) {
      this.items.push(pending.item);
      this.stats.highWaterMark = Math.max(this.stats.highWaterMark, this.items.length);
      this.settlePending(pending);
    }
  }

  private settlePending(pending: PendingPush<T>): void {
    this.stats.totalProducerStallMs += performance.now() - pending.enqueuedAt;
    pending.resolve();
  }
}
