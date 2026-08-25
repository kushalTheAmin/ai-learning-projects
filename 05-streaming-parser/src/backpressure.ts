/**
 * Bounded async channel — the primitive that turns "producer floods memory"
 * into "producer waits its turn".
 *
 * push() resolves immediately while the buffer has room and parks the
 * producer otherwise; pop() hands buffered items out FIFO and parks the
 * consumer when empty. With capacity Infinity this degrades to the naive
 * push-everything queue, which is exactly what the experiment measures
 * against. The channel records its own high-watermark so the cost of each
 * policy is a number, not a claim.
 */

interface Waiter<T> {
  resolve: (result: T) => void;
}

export type PopResult<T> = { done: false; value: T } | { done: true };

export class BoundedQueue<T> {
  private readonly items: T[] = [];
  private readonly waitingPops: Waiter<PopResult<T>>[] = [];
  private readonly waitingPushes: { item: T; resolve: () => void }[] = [];
  private closed = false;

  /** Largest number of items ever buffered at once. */
  peakLength = 0;
  /** Number of push() calls that had to wait for space. */
  blockedPushes = 0;

  constructor(private readonly capacity: number) {
    if (capacity < 1) throw new Error("capacity must be >= 1");
  }

  push(item: T): Promise<void> {
    if (this.closed) throw new Error("push after close");
    const waitingPop = this.waitingPops.shift();
    if (waitingPop !== undefined) {
      waitingPop.resolve({ done: false, value: item });
      return Promise.resolve();
    }
    if (this.items.length < this.capacity) {
      this.items.push(item);
      this.peakLength = Math.max(this.peakLength, this.items.length);
      return Promise.resolve();
    }
    this.blockedPushes++;
    return new Promise((resolve) => {
      this.waitingPushes.push({ item, resolve });
    });
  }

  pop(): Promise<PopResult<T>> {
    const value = this.items.shift();
    if (value !== undefined) {
      this.admitWaitingPush();
      return Promise.resolve({ done: false, value });
    }
    if (this.closed) return Promise.resolve({ done: true });
    return new Promise((resolve) => {
      this.waitingPops.push({ resolve });
    });
  }

  /** No more pushes will come. Buffered items still drain; waiting pops end. */
  close(): void {
    this.closed = true;
    if (this.items.length === 0 && this.waitingPushes.length === 0) {
      for (const waiter of this.waitingPops.splice(0)) {
        waiter.resolve({ done: true });
      }
    }
  }

  private admitWaitingPush(): void {
    const next = this.waitingPushes.shift();
    if (next !== undefined) {
      this.items.push(next.item);
      this.peakLength = Math.max(this.peakLength, this.items.length);
      next.resolve();
    } else if (this.closed && this.items.length === 0) {
      for (const waiter of this.waitingPops.splice(0)) {
        waiter.resolve({ done: true });
      }
    }
  }

  get length(): number {
    return this.items.length;
  }
}

export interface BackpressureReport {
  policy: string;
  peakBufferedItems: number;
  peakBufferedBytes: number;
  blockedPushes: number;
  wallMs: number;
  itemsProcessed: number;
}

/**
 * A fast producer pushes `chunks` through a queue to a consumer that yields
 * to the event loop after every item (a stand-in for per-chunk work like
 * parsing, rendering, or writing to a slower sink).
 *
 * Peak buffered bytes is peak items x mean chunk size — chunk sizes here are
 * uniform enough that the mean is honest, and it keeps accounting out of the
 * hot path.
 */
export async function runBackpressureExperiment(
  policy: string,
  chunks: Uint8Array[],
  capacity: number,
): Promise<BackpressureReport> {
  const queue = new BoundedQueue<Uint8Array>(capacity);
  const totalBytes = chunks.reduce((sum, c) => sum + c.length, 0);
  const meanChunkBytes = totalBytes / chunks.length;
  const started = performance.now();

  const producer = (async () => {
    for (const chunk of chunks) {
      await queue.push(chunk);
    }
    queue.close();
  })();

  let itemsProcessed = 0;
  const consumer = (async () => {
    for (;;) {
      const result = await queue.pop();
      if (result.done) return;
      itemsProcessed++;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  })();

  await Promise.all([producer, consumer]);

  return {
    policy,
    peakBufferedItems: queue.peakLength,
    peakBufferedBytes: Math.round(queue.peakLength * meanChunkBytes),
    blockedPushes: queue.blockedPushes,
    wallMs: performance.now() - started,
    itemsProcessed,
  };
}
