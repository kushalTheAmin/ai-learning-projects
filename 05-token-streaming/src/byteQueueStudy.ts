/**
 * Byte-budget study: what breaks when a queue counts chunks but memory is
 * spent in bytes.
 *
 * The workload is a heavy-tailed chunk-size mixture (mostly tiny SSE-style
 * deltas, occasional huge fragments, sizes spanning ~10000x), replayed
 * through queues capped in items, in bytes, or both. The producer can run
 * steadily or in bursts with silent gaps; the consumer takes one item per
 * macrotask. Everything measured is a count or a byte total, so runs are
 * deterministic for a seed.
 */

import { AsyncQueue, type QueueLimits } from "./queue.js";
import { createRng, randInt } from "./rng.js";

/**
 * Heavy-tailed chunk sizes: 90% tiny (3..30 bytes), 9% medium (200..2000),
 * 1% huge (16384..32768). The bands are what a token stream actually looks
 * like — keepalives and single-token deltas most of the time, a large
 * tool-argument or base64 fragment now and then.
 */
export function heavyTailedSizes(count: number, seed: number): number[] {
  const rng = createRng(seed);
  const sizes: number[] = [];
  for (let i = 0; i < count; i++) {
    const roll = rng();
    if (roll < 0.9) sizes.push(randInt(rng, 3, 30));
    else if (roll < 0.99) sizes.push(randInt(rng, 200, 2000));
    else sizes.push(randInt(rng, 16384, 32768));
  }
  return sizes;
}

/** Uniform sizes in [min, max]: the near-constant case where counting chunks was fine. */
export function uniformSizes(count: number, seed: number, min: number, max: number): number[] {
  const rng = createRng(seed);
  const sizes: number[] = [];
  for (let i = 0; i < count; i++) sizes.push(randInt(rng, min, max));
  return sizes;
}

/** Seeded Fisher-Yates copy; the input is left untouched. */
export function shuffled(sizes: readonly number[], seed: number): number[] {
  const rng = createRng(seed);
  const out = [...sizes];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randInt(rng, 0, i);
    const a = out[i]!;
    out[i] = out[j]!;
    out[j] = a;
  }
  return out;
}

export interface ProducerPacing {
  /** Push this many chunks back to back... */
  burstChunks: number;
  /** ...then stay silent for this many macrotask ticks. */
  gapTicks: number;
}

export interface StudyRun {
  consumed: number;
  itemsHighWater: number;
  bytesHighWater: number;
  stalledPushes: number;
  oversizedPushes: number;
  /** Macrotask ticks the consumer spent waiting on an empty buffer mid-stream. */
  consumerIdleTicks: number;
  /** Mean buffered bytes observed at each take — how much run-ahead the queue held. */
  meanBufferedBytes: number;
  meanBufferedItems: number;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Replay a chunk-size sequence through a queue: producer pushes every chunk
 * (optionally in bursts with gaps), consumer takes one item per tick. The
 * consumer polls instead of parking inside `next()`, so idle time is counted
 * in the same tick currency as its per-item cost. Delivery order and count
 * are verified against the input — the harness refuses to report numbers for
 * a queue that dropped or reordered anything.
 */
export async function replayThroughQueue(
  sizes: readonly number[],
  limits: QueueLimits<Uint8Array>,
  pacing?: ProducerPacing,
): Promise<StudyRun> {
  const queue = new AsyncQueue<Uint8Array>({ ...limits, sizeOf: (chunk) => chunk.byteLength });
  let producerFinished = false;

  const producer = (async () => {
    let inBurst = 0;
    for (let i = 0; i < sizes.length; i++) {
      await queue.push(new Uint8Array(sizes[i]!));
      const last = i === sizes.length - 1;
      if (pacing !== undefined && !last && ++inBurst === pacing.burstChunks) {
        inBurst = 0;
        for (let g = 0; g < pacing.gapTicks; g++) await tick();
      }
    }
    queue.close();
    producerFinished = true;
  })();

  let consumed = 0;
  let idleTicks = 0;
  let bufferedBytesSum = 0;
  let bufferedItemsSum = 0;
  const iterator = queue[Symbol.asyncIterator]();
  const consumer = (async () => {
    for (;;) {
      while (queue.size === 0 && !producerFinished) {
        idleTicks++;
        await tick();
      }
      if (queue.size === 0) break;
      bufferedBytesSum += queue.bufferedBytes;
      bufferedItemsSum += queue.size;
      const result = await iterator.next();
      if (result.done) break;
      const expected = sizes[consumed];
      if (result.value.byteLength !== expected) {
        throw new Error(`chunk ${consumed}: got ${result.value.byteLength} bytes, expected ${expected}`);
      }
      consumed++;
      await tick();
    }
  })();

  await Promise.all([producer, consumer]);
  if (consumed !== sizes.length) {
    throw new Error(`consumed ${consumed} of ${sizes.length} chunks`);
  }
  return {
    consumed,
    itemsHighWater: queue.stats.highWaterMark,
    bytesHighWater: queue.stats.sizeHighWaterMark,
    stalledPushes: queue.stats.stalledPushes,
    oversizedPushes: queue.stats.oversizedPushes,
    consumerIdleTicks: idleTicks,
    meanBufferedBytes: consumed === 0 ? 0 : bufferedBytesSum / consumed,
    meanBufferedItems: consumed === 0 ? 0 : bufferedItemsSum / consumed,
  };
}

export interface WorkloadSummary {
  count: number;
  totalBytes: number;
  minSize: number;
  medianSize: number;
  maxSize: number;
  /** Fraction of total bytes carried by chunks larger than `hugeAbove`. */
  hugeByteShare: number;
  hugeCount: number;
}

export function summarizeWorkload(sizes: readonly number[], hugeAbove: number): WorkloadSummary {
  const sorted = [...sizes].sort((a, b) => a - b);
  const totalBytes = sizes.reduce((sum, size) => sum + size, 0);
  const hugeBytes = sizes.filter((s) => s > hugeAbove).reduce((sum, size) => sum + size, 0);
  return {
    count: sizes.length,
    totalBytes,
    minSize: sorted[0] ?? 0,
    medianSize: sorted[Math.floor(sorted.length / 2)] ?? 0,
    maxSize: sorted[sorted.length - 1] ?? 0,
    hugeByteShare: totalBytes === 0 ? 0 : hugeBytes / totalBytes,
    hugeCount: sizes.filter((s) => s > hugeAbove).length,
  };
}
