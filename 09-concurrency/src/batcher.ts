/**
 * Micro-batcher: submitted items collect into an open batch that is
 * dispatched when it reaches `maxBatchSize` or when `maxWaitMs` has passed
 * since the batch opened, whichever comes first. Each submit gets a promise
 * for its own item's result, dispatch happens on whole batches.
 *
 * With a virtual clock timers cannot be cancelled, so each batch carries an
 * id and the flush timer re-checks it on firing: if the batch already went
 * out size-triggered, the stale timer is a no-op instead of flushing a
 * younger batch early.
 */
import { VirtualClock } from "../../06-rate-limiting/src/clock.js";

export interface BatcherOptions<T, R> {
  maxBatchSize: number;
  /** 0 means dispatch immediately on every submit (no coalescing). */
  maxWaitMs: number;
  dispatch: (items: T[]) => Promise<R[]>;
}

export interface BatcherStats {
  batchesDispatched: number;
  itemsSubmitted: number;
  batchSizes: number[];
}

interface OpenBatch<T, R> {
  id: number;
  items: T[];
  resolvers: Array<{ resolve: (value: R) => void; reject: (error: unknown) => void }>;
}

export class MicroBatcher<T, R> {
  private open: OpenBatch<T, R> | null = null;
  private nextBatchId = 0;
  private readonly stats: BatcherStats = {
    batchesDispatched: 0,
    itemsSubmitted: 0,
    batchSizes: [],
  };

  constructor(
    private readonly clock: VirtualClock,
    private readonly opts: BatcherOptions<T, R>,
  ) {
    if (!Number.isInteger(opts.maxBatchSize) || opts.maxBatchSize < 1) {
      throw new Error(`maxBatchSize must be a positive integer, got ${opts.maxBatchSize}`);
    }
    if (!Number.isFinite(opts.maxWaitMs) || opts.maxWaitMs < 0) {
      throw new Error(`maxWaitMs must be a finite non-negative number, got ${opts.maxWaitMs}`);
    }
  }

  submit(item: T): Promise<R> {
    if (!this.open) {
      const batch: OpenBatch<T, R> = { id: this.nextBatchId++, items: [], resolvers: [] };
      this.open = batch;
      if (this.opts.maxWaitMs > 0) {
        void this.clock.sleep(this.opts.maxWaitMs).then(() => {
          if (this.open?.id === batch.id) this.flush();
        });
      }
    }
    const batch = this.open;
    batch.items.push(item);
    this.stats.itemsSubmitted++;
    const result = new Promise<R>((resolve, reject) => {
      batch.resolvers.push({ resolve, reject });
    });
    if (batch.items.length >= this.opts.maxBatchSize || this.opts.maxWaitMs === 0) {
      this.flush();
    }
    return result;
  }

  /** Dispatch whatever is currently collected, if anything. */
  flush(): void {
    const batch = this.open;
    if (!batch) return;
    this.open = null;
    this.stats.batchesDispatched++;
    this.stats.batchSizes.push(batch.items.length);
    void this.opts.dispatch(batch.items).then(
      (results) => {
        if (results.length !== batch.items.length) {
          const error = new Error(
            `dispatch returned ${results.length} results for ${batch.items.length} items`,
          );
          for (const r of batch.resolvers) r.reject(error);
          return;
        }
        batch.resolvers.forEach((r, i) => r.resolve(results[i] as R));
      },
      (error) => {
        for (const r of batch.resolvers) r.reject(error);
      },
    );
  }

  pending(): number {
    return this.open?.items.length ?? 0;
  }

  snapshot(): BatcherStats {
    return { ...this.stats, batchSizes: [...this.stats.batchSizes] };
  }
}
