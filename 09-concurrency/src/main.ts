/**
 * Entry point: run all four experiments and print every measured number.
 * Everything is virtual-time and seeded, so this output is exactly
 * reproducible run to run.
 */
import { DEFAULT_API_OPTIONS } from "./api.js";
import {
  BATCH_SWEEP,
  ISOLATION,
  MICRO_BATCH,
  WORKER_SWEEP,
  runBatchSizeSweep,
  runIsolationSweep,
  runMicroBatchSweep,
  runWorkerSweep,
} from "./experiment.js";

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) =>
    cells.map((c, i) => c.padStart(widths[i]!)).join("  ");
  return [line(headers), ...rows.map(line)].join("\n");
}

const ms = (v: number) => `${v.toFixed(0)}ms`;
const sec = (v: number) => `${(v / 1000).toFixed(2)}s`;
const f1 = (v: number) => v.toFixed(1);
const f2 = (v: number) => v.toFixed(2);
const usd = (v: number) => `$${v.toFixed(3)}`;

async function main(): Promise<void> {
  const o = DEFAULT_API_OPTIONS;
  console.log(
    `simulated api: ${o.baseLatencyMs}ms + ${o.perItemLatencyMs}ms/item ±${o.latencyJitter * 100}%, ` +
      `server works ${o.maxConcurrent} calls at once, max ${o.maxItemsPerCall} items/call`,
  );
  console.log(
    `tokens: ${o.promptOverheadTokens} overhead/call + ${o.perItemInputTokens} in + ${o.perItemOutputTokens} out per item, ` +
      `priced $${o.inputPricePerMTok}/$${o.outputPricePerMTok} per MTok in/out (seed ${WORKER_SWEEP.seed})`,
  );

  console.log(
    `\n== 1. worker sweep: ${WORKER_SWEEP.taskCount} single-item calls, server cap ${o.maxConcurrent} ==`,
  );
  const sweep = await runWorkerSweep();
  console.log(
    table(
      ["workers", "makespan", "req/s", "req p50", "req p95", "srv queue p95", "high water"],
      sweep.map((r) => [
        String(r.limit),
        sec(r.makespanMs),
        f1(r.throughputPerSec),
        ms(r.requestP50Ms),
        ms(r.requestP95Ms),
        ms(r.serverQueueP95Ms),
        String(r.concurrencyHighWater),
      ]),
    ),
  );

  console.log(
    `\n== 2. batch size: ${BATCH_SWEEP.itemCount} items, ${BATCH_SWEEP.clientConcurrency} client workers ==`,
  );
  const batch = await runBatchSizeSweep();
  console.log(
    table(
      ["batch", "calls", "in tok/item", "$/1k items", "makespan", "call p50", "call p95", "item p50", "item p95"],
      batch.map((r) => [
        String(r.batchSize),
        String(r.calls),
        f1(r.inputTokensPerItem),
        usd(r.usdPer1kItems),
        sec(r.makespanMs),
        ms(r.callP50Ms),
        ms(r.callP95Ms),
        ms(r.itemP50Ms),
        ms(r.itemP95Ms),
      ]),
    ),
  );

  console.log(
    `\n== 3. micro-batching: ${MICRO_BATCH.itemCount} items arriving ~every ${MICRO_BATCH.meanInterArrivalMs}ms, ` +
      `batch cap ${MICRO_BATCH.maxBatchSize} ==`,
  );
  const micro = await runMicroBatchSweep();
  console.log(
    table(
      ["max wait", "calls", "mean batch", "in tok/item", "$/1k items", "lat p50", "lat p95", "makespan"],
      micro.map((r) => [
        ms(r.maxWaitMs),
        String(r.calls),
        f2(r.meanBatchSize),
        f1(r.inputTokensPerItem),
        usd(r.usdPer1kItems),
        ms(r.latencyP50Ms),
        ms(r.latencyP95Ms),
        sec(r.makespanMs),
      ]),
    ),
  );

  console.log(
    `\n== 4. poisoned batch of ${ISOLATION.batchSize}: recovery strategy cost ==`,
  );
  const isolation = await runIsolationSweep();
  console.log(
    table(
      ["poisoned", "strategy", "calls", "in tokens", "completed", "lost", "identified", "elapsed"],
      isolation.map((r) => [
        String(r.poisonedCount),
        r.strategy,
        String(r.calls),
        String(r.inputTokens),
        String(r.completed),
        String(r.lostHealthy),
        String(r.identified),
        ms(r.elapsedMs),
      ]),
    ),
  );
}

await main();
