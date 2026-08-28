/**
 * Four measured questions, all on the virtual clock so every number is a
 * pure function of the seed:
 *
 * 1. worker sweep — what does client-side parallelism buy against a server
 *    that only works `maxConcurrent` calls at a time?
 * 2. batch-size sweep — what does putting n items in one call do to cost per
 *    item, to how long a call takes, and to how long an item waits?
 * 3. micro-batching under arrivals — with items trickling in, how long is it
 *    worth holding a batch open to fill it?
 * 4. poisoned batches — when one bad item fails the whole call, what does
 *    each recovery strategy cost and save?
 */
import { VirtualClock } from "../../06-rate-limiting/src/clock.js";
import { percentile } from "../../06-rate-limiting/src/percentile.js";
import { createRng } from "../../05-token-streaming/src/rng.js";
import { SimulatedApi, costUsd, makeItems } from "./api.js";
import type { WorkItem } from "./api.js";
import { MicroBatcher } from "./batcher.js";
import { mapBoundedSettled } from "./pool.js";
import { ISOLATION_STRATEGIES, runWithIsolation } from "./isolate.js";
import type { IsolationStrategy } from "./isolate.js";

export const DEFAULT_SEED = 42;

function p(values: readonly number[], q: number): number {
  return percentile([...values].sort((a, b) => a - b), q);
}

function assertAllOk(results: ReadonlyArray<{ status: string }>, where: string): void {
  const failed = results.filter((r) => r.status !== "ok").length;
  if (failed > 0) {
    throw new Error(`${where}: ${failed} calls failed unexpectedly`);
  }
}

// ---------------------------------------------------------------- experiment 1

export interface WorkerSweepRow {
  limit: number;
  makespanMs: number;
  throughputPerSec: number;
  requestP50Ms: number;
  requestP95Ms: number;
  serverQueueP95Ms: number;
  concurrencyHighWater: number;
}

export interface WorkerSweepConfig {
  seed: number;
  taskCount: number;
  limits: readonly number[];
}

export const WORKER_SWEEP: WorkerSweepConfig = {
  seed: DEFAULT_SEED,
  taskCount: 200,
  limits: [1, 2, 4, 8, 16, 32, 64],
};

export async function runWorkerSweep(cfg: WorkerSweepConfig = WORKER_SWEEP): Promise<WorkerSweepRow[]> {
  const rows: WorkerSweepRow[] = [];
  for (const limit of cfg.limits) {
    const clock = new VirtualClock();
    const api = new SimulatedApi(clock, createRng(cfg.seed));
    const latencies: number[] = [];
    const run = mapBoundedSettled(makeItems(cfg.taskCount), limit, async (item) => {
      const startedAt = clock.now();
      const result = await api.call([item]);
      latencies.push(clock.now() - startedAt);
      return result;
    });
    const { results, stats } = await clock.runUntil(run);
    assertAllOk(results, `worker sweep limit=${limit}`);
    const makespanMs = clock.now();
    rows.push({
      limit,
      makespanMs,
      throughputPerSec: (cfg.taskCount / makespanMs) * 1000,
      requestP50Ms: p(latencies, 0.5),
      requestP95Ms: p(latencies, 0.95),
      serverQueueP95Ms: p(api.snapshot().queueWaitsMs, 0.95),
      concurrencyHighWater: stats.concurrencyHighWater,
    });
  }
  return rows;
}

// ---------------------------------------------------------------- experiment 2

export interface BatchSizeRow {
  batchSize: number;
  calls: number;
  inputTokensPerItem: number;
  usdPer1kItems: number;
  makespanMs: number;
  /** How long one call takes once a client worker picks it up. */
  callP50Ms: number;
  callP95Ms: number;
  /**
   * How long an item waits for its own result, measured from the start of
   * the job. Every item is handed to the pool at t=0 here, so this includes
   * the client-queue time the call latency leaves out — and that queue is
   * exactly what a bigger batch shortens.
   */
  itemP50Ms: number;
  itemP95Ms: number;
}

export interface BatchSizeConfig {
  seed: number;
  itemCount: number;
  clientConcurrency: number;
  batchSizes: readonly number[];
}

export const BATCH_SWEEP: BatchSizeConfig = {
  seed: DEFAULT_SEED,
  itemCount: 240,
  clientConcurrency: 4,
  batchSizes: [1, 2, 4, 8, 16, 32],
};

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export async function runBatchSizeSweep(cfg: BatchSizeConfig = BATCH_SWEEP): Promise<BatchSizeRow[]> {
  const rows: BatchSizeRow[] = [];
  for (const batchSize of cfg.batchSizes) {
    const clock = new VirtualClock();
    const api = new SimulatedApi(clock, createRng(cfg.seed));
    const callLatencies: number[] = [];
    const itemLatencies: number[] = [];
    const batches = chunk(makeItems(cfg.itemCount), batchSize);
    const run = mapBoundedSettled(batches, cfg.clientConcurrency, async (batch) => {
      const startedAt = clock.now();
      const result = await api.call(batch);
      const elapsed = clock.now() - startedAt;
      // Every batch is submitted at t=0, so the clock reading at completion
      // is the item's own wait, client queue included.
      const finishedAt = clock.now();
      for (let i = 0; i < batch.length; i++) {
        callLatencies.push(elapsed);
        itemLatencies.push(finishedAt);
      }
      return result;
    });
    const { results } = await clock.runUntil(run);
    assertAllOk(results, `batch sweep size=${batchSize}`);
    const stats = api.snapshot();
    rows.push({
      batchSize,
      calls: stats.calls,
      inputTokensPerItem: stats.inputTokens / cfg.itemCount,
      usdPer1kItems: (costUsd(stats.inputTokens, stats.outputTokens, api.opts) / cfg.itemCount) * 1000,
      makespanMs: clock.now(),
      callP50Ms: p(callLatencies, 0.5),
      callP95Ms: p(callLatencies, 0.95),
      itemP50Ms: p(itemLatencies, 0.5),
      itemP95Ms: p(itemLatencies, 0.95),
    });
  }
  return rows;
}

// ---------------------------------------------------------------- experiment 3

export interface MicroBatchRow {
  maxWaitMs: number;
  calls: number;
  meanBatchSize: number;
  inputTokensPerItem: number;
  usdPer1kItems: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  makespanMs: number;
}

export interface MicroBatchConfig {
  seed: number;
  itemCount: number;
  meanInterArrivalMs: number;
  maxBatchSize: number;
  maxWaits: readonly number[];
}

export const MICRO_BATCH: MicroBatchConfig = {
  seed: DEFAULT_SEED,
  itemCount: 600,
  meanInterArrivalMs: 20,
  maxBatchSize: 16,
  maxWaits: [0, 25, 50, 100, 250],
};

export async function runMicroBatchSweep(cfg: MicroBatchConfig = MICRO_BATCH): Promise<MicroBatchRow[]> {
  // One arrival schedule shared by every sweep point: the arrival rng is
  // separate from the api's latency rng so neither perturbs the other.
  const arrivalRng = createRng(cfg.seed);
  const interArrivals = Array.from(
    { length: cfg.itemCount },
    () => -cfg.meanInterArrivalMs * Math.log(1 - arrivalRng()),
  );
  const rows: MicroBatchRow[] = [];
  for (const maxWaitMs of cfg.maxWaits) {
    const clock = new VirtualClock();
    const api = new SimulatedApi(clock, createRng(cfg.seed + 1));
    const batcher = new MicroBatcher<WorkItem, unknown>(clock, {
      maxBatchSize: cfg.maxBatchSize,
      maxWaitMs,
      dispatch: (items) => api.call(items),
    });
    const items = makeItems(cfg.itemCount);
    const driver = (async () => {
      const latencyPromises: Promise<number>[] = [];
      for (let i = 0; i < items.length; i++) {
        await clock.sleep(interArrivals[i]!);
        const submittedAt = clock.now();
        latencyPromises.push(batcher.submit(items[i]!).then(() => clock.now() - submittedAt));
      }
      return Promise.all(latencyPromises);
    })();
    const latencies = await clock.runUntil(driver);
    const stats = api.snapshot();
    rows.push({
      maxWaitMs,
      calls: stats.calls,
      meanBatchSize: cfg.itemCount / stats.calls,
      inputTokensPerItem: stats.inputTokens / cfg.itemCount,
      usdPer1kItems: (costUsd(stats.inputTokens, stats.outputTokens, api.opts) / cfg.itemCount) * 1000,
      latencyP50Ms: p(latencies, 0.5),
      latencyP95Ms: p(latencies, 0.95),
      makespanMs: clock.now(),
    });
  }
  return rows;
}

// ---------------------------------------------------------------- experiment 4

export interface IsolationRow {
  poisonedCount: number;
  strategy: IsolationStrategy;
  calls: number;
  inputTokens: number;
  completed: number;
  lostHealthy: number;
  identified: number;
  elapsedMs: number;
}

export interface IsolationConfig {
  seed: number;
  batchSize: number;
  poisonSets: ReadonlyArray<readonly number[]>;
}

export const ISOLATION: IsolationConfig = {
  seed: DEFAULT_SEED,
  batchSize: 32,
  poisonSets: [[17], [5, 26], [3, 12, 21, 30]],
};

export async function runIsolationSweep(cfg: IsolationConfig = ISOLATION): Promise<IsolationRow[]> {
  const rows: IsolationRow[] = [];
  for (const poisonedIds of cfg.poisonSets) {
    for (const strategy of ISOLATION_STRATEGIES) {
      const clock = new VirtualClock();
      const api = new SimulatedApi(clock, createRng(cfg.seed));
      const items = makeItems(cfg.batchSize, poisonedIds);
      const outcome = await clock.runUntil(runWithIsolation(api, clock, items, strategy));
      rows.push({
        poisonedCount: poisonedIds.length,
        strategy,
        calls: outcome.calls,
        inputTokens: outcome.inputTokens,
        completed: outcome.completed.length,
        lostHealthy: outcome.lostHealthy,
        identified: outcome.poisonedIdentified.length,
        elapsedMs: outcome.elapsedMs,
      });
    }
  }
  return rows;
}
