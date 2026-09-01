/**
 * Bounded async queue: the backpressure primitive between a fast producer
 * (the network) and a slow consumer (rendering, disk, a downstream API).
 *
 * `push` resolves immediately while the buffer has room and otherwise not
 * until the consumer frees enough space — so an `await queue.push(x)`
 * producer is paced by the consumer instead of buffering without limit.
 * Consumption is a plain `for await` loop.
 *
 * Capacity comes in two currencies. The positional form counts items:
 * `new AsyncQueue(8, sizeOf)` admits up to 8 items and uses `sizeOf` for
 * statistics only. The options form can also budget bytes:
 * `new AsyncQueue({ maxBytes, sizeOf })` admits an item only while the
 * buffered `sizeOf` total plus the item stays inside the budget, which is
 * what a real memory ceiling wants once item sizes vary by 1000x. One rule
 * keeps the byte budget deadlock-free: an item is always admitted into an
 * empty buffer, even when it alone exceeds `maxBytes` — otherwise a single
 * oversized item would wait forever on space that can never appear. The
 * buffered-bytes bound is therefore max(maxBytes, largest single item),
 * and `stats.oversizedPushes` counts how often the escape hatch fired.
 *
 * The queue records its own evidence: buffer high-water mark in items, the
 * same in whatever unit `sizeOf` measures, and total time producers spent
 * blocked.
 */

export interface QueueStats {
  highWaterMark: number;
  /** Peak sum of `sizeOf` over the buffered items; 0 when no `sizeOf` was given. */
  sizeHighWaterMark: number;
  totalProducerStallMs: number;
  pushes: number;
  stalledPushes: number;
  /** Items admitted alone into an empty buffer despite exceeding `maxBytes`. */
  oversizedPushes: number;
}

export interface QueueLimits<T> {
  /** Maximum buffered items; unlimited when omitted. */
  maxItems?: number;
  /** Maximum buffered `sizeOf` total; requires `sizeOf`. Unlimited when omitted. */
  maxBytes?: number;
  /** Measures an item; admission (under `maxBytes`) and stats both use it. */
  sizeOf?: (item: T) => number;
}

interface BufferedItem<T> {
  item: T;
  size: number;
}

interface PendingPush<T> {
  item: T;
  size: number;
  resolve: () => void;
  enqueuedAt: number;
}

export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: BufferedItem<T>[] = [];
  private readonly pendingPushes: PendingPush<T>[] = [];
  private readonly takers: ((result: IteratorResult<T>) => void)[] = [];
  private readonly maxItems: number;
  private readonly maxBytes: number;
  private readonly sizeOf: (item: T) => number;
  private closed = false;
  private bufferedSize = 0;
  readonly stats: QueueStats = {
    highWaterMark: 0,
    sizeHighWaterMark: 0,
    totalProducerStallMs: 0,
    pushes: 0,
    stalledPushes: 0,
    oversizedPushes: 0,
  };

  constructor(capacity?: number, sizeOf?: (item: T) => number);
  constructor(limits: QueueLimits<T>);
  constructor(
    capacityOrLimits: number | QueueLimits<T> = Infinity,
    sizeOf: (item: T) => number = () => 0,
  ) {
    if (typeof capacityOrLimits === "number") {
      if (capacityOrLimits < 1) throw new RangeError("capacity must be >= 1");
      this.maxItems = capacityOrLimits;
      this.maxBytes = Infinity;
      this.sizeOf = sizeOf;
    } else {
      const { maxItems = Infinity, maxBytes = Infinity } = capacityOrLimits;
      if (maxItems < 1) throw new RangeError("maxItems must be >= 1");
      if (maxBytes <= 0) throw new RangeError("maxBytes must be > 0");
      if (maxBytes < Infinity && capacityOrLimits.sizeOf === undefined) {
        throw new TypeError("maxBytes requires a sizeOf function");
      }
      this.maxItems = maxItems;
      this.maxBytes = maxBytes;
      this.sizeOf = capacityOrLimits.sizeOf ?? (() => 0);
    }
  }

  get size(): number {
    return this.items.length;
  }

  /** Current sum of `sizeOf` over the buffered items. */
  get bufferedBytes(): number {
    return this.bufferedSize;
  }

  /** Resolves once the item is accepted; blocks while the buffer is full. */
  push(item: T): Promise<void> {
    if (item === undefined) {
      // undefined is the internal "buffer empty" sentinel and cannot be queued
      return Promise.reject(new TypeError("undefined items are not supported"));
    }
    if (this.closed) return Promise.reject(new Error("push after close"));
    const size = this.sizeOf(item);
    if (!Number.isFinite(size) || size < 0) {
      return Promise.reject(new TypeError(`sizeOf must return a finite non-negative number, got ${size}`));
    }
    this.stats.pushes++;
    const taker = this.takers.shift();
    if (taker !== undefined) {
      taker({ value: item, done: false });
      return Promise.resolve();
    }
    // A push behind waiting producers must wait its turn even if it would
    // fit — under a byte budget a small item could otherwise jump the line.
    if (this.pendingPushes.length === 0 && this.admits(size)) {
      this.buffer(item, size);
      return Promise.resolve();
    }
    this.stats.stalledPushes++;
    return new Promise((resolve) => {
      this.pendingPushes.push({ item, size, resolve, enqueuedAt: performance.now() });
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
        const entry = this.items.shift();
        if (entry !== undefined) {
          this.bufferedSize -= entry.size;
          this.admitPending();
          return Promise.resolve({ value: entry.item, done: false });
        }
        const pending = this.pendingPushes.shift();
        if (pending !== undefined) {
          this.settlePending(pending);
          this.admitPending();
          return Promise.resolve({ value: pending.item, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => this.takers.push(resolve));
      },
    };
  }

  /**
   * Whether an item of this size fits right now. The empty-buffer clause is
   * the deadlock escape: with nothing buffered there is no drain event left
   * to wait for, so the item is admitted whatever its size.
   */
  private admits(size: number): boolean {
    if (this.items.length >= this.maxItems) return false;
    return this.items.length === 0 || this.bufferedSize + size <= this.maxBytes;
  }

  /**
   * Move waiting producers into freed space, in arrival order. A byte budget
   * can free room for several small pending items on one large drain, so
   * this loops; under a pure item cap one take frees one slot and the loop
   * admits exactly one, matching the item-counted behavior.
   */
  private admitPending(): void {
    let head = this.pendingPushes[0];
    while (head !== undefined && this.admits(head.size)) {
      this.pendingPushes.shift();
      this.buffer(head.item, head.size);
      this.settlePending(head);
      head = this.pendingPushes[0];
    }
  }

  /** Take an item into the buffer and record both high-water marks. */
  private buffer(item: T, size: number): void {
    if (size > this.maxBytes) this.stats.oversizedPushes++;
    this.items.push({ item, size });
    this.bufferedSize += size;
    this.stats.highWaterMark = Math.max(this.stats.highWaterMark, this.items.length);
    this.stats.sizeHighWaterMark = Math.max(this.stats.sizeHighWaterMark, this.bufferedSize);
  }

  private settlePending(pending: PendingPush<T>): void {
    this.stats.totalProducerStallMs += performance.now() - pending.enqueuedAt;
    pending.resolve();
  }
}
