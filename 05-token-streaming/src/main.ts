/**
 * Runs the three measurements and prints real numbers:
 *
 *   1. Streaming vs buffering on the scripted turn: time to first visible
 *      text against total stream time.
 *   2. Partial JSON on streamed tool-call arguments: how early each field
 *      becomes readable, against the 100% baseline of waiting for the
 *      closing brace.
 *   3. Backpressure: unbounded vs bounded queue between a fast producer and
 *      a slow consumer — buffer high-water mark, producer stall time, wall
 *      time.
 *
 * Everything is offline and deterministic: the stream is the scripted
 * fixture, chunk boundaries come from a seeded PRNG.
 */

import { scriptedSseBytes, ASSISTANT_TEXT, TOOL_ARGS } from "./fixture.js";
import { chunkBytes } from "./chunker.js";
import { runPipeline } from "./pipeline.js";
import { parseSseComplete } from "./sse.js";
import { chunkOffsets } from "./chunker.js";
import { AsyncQueue } from "./queue.js";
import { SseParser } from "./sse.js";

const SEED = 20260826;

function fmt(n: number, digits = 1): string {
  return n.toFixed(digits);
}

async function streamingDemo(): Promise<void> {
  const bytes = scriptedSseBytes();
  const result = await runPipeline(
    chunkBytes(bytes, { seed: SEED, maxChunkBytes: 24, delayMs: 2 }),
    bytes.length,
  );

  console.log("== 1. streaming parse of the scripted turn ==");
  console.log(`stream: ${result.byteCount} bytes in ${result.chunkCount} chunks (1..24 bytes, 2ms apart)`);
  console.log(`events parsed: ${result.events.length}`);
  const ttft = result.timeToFirstTextMs ?? NaN;
  console.log(
    `time to first text: ${fmt(ttft)}ms of ${fmt(result.totalMs)}ms total ` +
      `(first output at ${fmt((100 * ttft) / result.totalMs)}% of the wait a buffering client pays)`,
  );
  const textOk = result.text === ASSISTANT_TEXT;
  const argsOk = JSON.stringify(result.toolArgs) === JSON.stringify(TOOL_ARGS);
  console.log(`reassembled text identical: ${textOk}, tool args identical: ${argsOk}`);
  if (!textOk || !argsOk) throw new Error("reassembly mismatch");
  console.log("");
}

async function partialJsonDemo(): Promise<void> {
  const bytes = scriptedSseBytes();
  const result = await runPipeline(
    chunkBytes(bytes, { seed: SEED, maxChunkBytes: 24, delayMs: 0 }),
    bytes.length,
  );

  console.log("== 2. partial JSON over streamed tool-call arguments ==");
  const parseable = result.argSnapshots.filter((s) => s.status !== "unparseable").length;
  console.log(
    `argument fragments: ${result.argSnapshots.length}, snapshots yielding a value: ` +
      `${parseable}/${result.argSnapshots.length}`,
  );
  console.log("field availability (fraction of stream bytes received when field first parsed):");
  for (const { field, availableAtByteFraction } of result.fieldAvailability) {
    console.log(`  ${field.padEnd(18)} ${fmt(100 * availableAtByteFraction)}%`);
  }
  console.log("  waiting for complete JSON = 100.0% for every field");
  console.log("");
}

interface QueueRun {
  label: string;
  highWaterMark: number;
  stallMs: number;
  wallMs: number;
  peakBufferedBytes: number;
}

async function runQueue(capacity: number, label: string): Promise<QueueRun> {
  const bytes = scriptedSseBytes();
  const boundaries = chunkOffsets(bytes.length, SEED, 24);
  const queue = new AsyncQueue<Uint8Array>(capacity, (chunk) => chunk.byteLength);

  const started = performance.now();
  const producer = (async () => {
    // Fast producer: the whole stream is already in the kernel buffer.
    let prev = 0;
    for (const boundary of boundaries) {
      await queue.push(bytes.subarray(prev, boundary));
      prev = boundary;
    }
    queue.close();
  })();

  const parser = new SseParser();
  let events = 0;
  const consumer = (async () => {
    for await (const chunk of queue) {
      events += parser.feed(chunk).length;
      // Slow consumer: pretend each chunk costs a millisecond to render.
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    events += parser.end().length;
  })();

  await Promise.all([producer, consumer]);
  return {
    label,
    highWaterMark: queue.stats.highWaterMark,
    stallMs: queue.stats.totalProducerStallMs,
    wallMs: performance.now() - started,
    peakBufferedBytes: queue.stats.sizeHighWaterMark,
  };
}

async function backpressureDemo(): Promise<void> {
  console.log("== 3. backpressure: fast producer, slow consumer (1ms per chunk) ==");
  const unbounded = await runQueue(Infinity, "unbounded");
  const bounded = await runQueue(8, "bounded(8)");
  for (const run of [unbounded, bounded]) {
    console.log(
      `${run.label.padEnd(12)} buffer high-water ${String(run.highWaterMark).padStart(4)} chunks` +
        ` (~${run.peakBufferedBytes} bytes)  producer stalled ${fmt(run.stallMs)}ms` +
        `  wall ${fmt(run.wallMs)}ms`,
    );
  }
  console.log(
    "same wall time either way — the consumer is the bottleneck — but the bounded queue" +
      "\nholds memory flat by making the producer wait instead of buffering the backlog.",
  );
  console.log("");
}

async function fuzzDemo(): Promise<void> {
  const bytes = scriptedSseBytes();
  const reference = JSON.stringify(parseSseComplete(bytes));
  const seeds = 300;
  let identical = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    const parser = new SseParser();
    const events = [];
    let prev = 0;
    for (const boundary of chunkOffsets(bytes.length, seed, 17)) {
      events.push(...parser.feed(bytes.subarray(prev, boundary)));
      prev = boundary;
    }
    events.push(...parser.end());
    if (JSON.stringify(events) === reference) identical++;
  }
  console.log("== 4. chunk-boundary fuzz ==");
  console.log(
    `${identical}/${seeds} random byte-level chunkings produced byte-identical event sequences`,
  );
  if (identical !== seeds) throw new Error("fuzz mismatch");
}

await streamingDemo();
await partialJsonDemo();
await backpressureDemo();
await fuzzDemo();
