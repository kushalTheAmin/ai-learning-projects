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
import { parsePartialJson } from "./partialJson.js";
import { ResumableJsonParser } from "./resumableJson.js";
import { baselineScanChars, makeToolCallJson, replayTimed } from "./resumableBench.js";
import {
  heavyTailedSizes,
  uniformSizes,
  shuffled,
  summarizeWorkload,
  replayThroughQueue,
  type ProducerPacing,
  type StudyRun,
} from "./byteQueueStudy.js";
import {
  normalEventsWire,
  giantLineEventWire,
  unterminatedLineWire,
  manyLineEventWire,
  replayInChunks,
} from "./sseLimitStudy.js";

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
  console.log("field availability (fraction of stream bytes received):");
  console.log(`  ${"field".padEnd(18)} ${"first parsed".padStart(12)} ${"carries a value".padStart(15)}`);
  for (const { field, availableAtByteFraction, nonEmptyAtByteFraction } of result.fieldAvailability) {
    const nonEmpty =
      nonEmptyAtByteFraction === null ? "never" : `${fmt(100 * nonEmptyAtByteFraction)}%`;
    console.log(
      `  ${field.padEnd(18)} ${`${fmt(100 * availableAtByteFraction)}%`.padStart(12)} ` +
        `${nonEmpty.padStart(15)}`,
    );
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

function resumableDemo(): void {
  console.log("");
  console.log("== 5. resumable partial-JSON scan vs full rescan ==");

  // Equivalence: the resumable view must match the baseline at every
  // fragment boundary, under adversarial chunking of the fixture arguments.
  const argsJson = JSON.stringify(TOOL_ARGS);
  const seeds = 300;
  let identical = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    const parser = new ResumableJsonParser();
    let previous = 0;
    let allMatch = true;
    for (const boundary of chunkOffsets(argsJson.length, seed, 17)) {
      parser.push(argsJson.slice(previous, boundary));
      previous = boundary;
      const resumable = JSON.stringify(parser.view());
      const baseline = JSON.stringify(parsePartialJson(argsJson.slice(0, boundary)));
      if (resumable !== baseline) allMatch = false;
    }
    if (allMatch) identical++;
  }
  console.log(
    `equivalence: ${identical}/${seeds} seeded chunkings match the rescan baseline at every fragment boundary`,
  );
  if (identical !== seeds) throw new Error("resumable/baseline mismatch");

  // Cost: one value materialized after every fragment, seeded fragments of
  // 1..24 chars, median wall time over the repeat count per row.
  const benchSeed = SEED;
  const rows: { target: number; repeats: number }[] = [
    { target: 256, repeats: 50 },
    { target: 1024, repeats: 20 },
    { target: 8192, repeats: 5 },
    { target: 65536, repeats: 3 },
  ];
  // Work first: chars fed through a scanner is exact and identical every
  // run, so it is what the readme publishes. The wall clock follows, and
  // the ratio between the two time columns is left for the reader to take
  // or leave — it moves by more than 2x run to run on one machine.
  console.log("work per replay, one value after every fragment (fragments of 1..24 chars, exact every run):");
  console.log(
    `  ${"doc chars".padStart(9)} ${"fragments".padStart(9)} ${"baseline scan".padStart(13)}` +
      ` ${"vs doc".padStart(8)} ${"resumable scan".padStart(14)}`,
  );
  const timings: { json: string; baseline: number; view: number; snapshot: number; repeats: number }[] = [];
  for (const { target, repeats } of rows) {
    const json = makeToolCallJson(target, benchSeed);
    const baseline = replayTimed(json, benchSeed, 24, "baseline", repeats);
    const view = replayTimed(json, benchSeed, 24, "view", repeats);
    const snapshot = replayTimed(json, benchSeed, 24, "snapshot", repeats);
    if (baseline.finalResult !== view.finalResult || baseline.finalResult !== snapshot.finalResult) {
      throw new Error(`final results diverge at ${target} chars`);
    }
    console.log(
      `  ${String(json.length).padStart(9)} ${String(view.fragments).padStart(9)}` +
        ` ${String(baseline.charsScanned).padStart(13)}` +
        ` ${`${fmt(baseline.charsScanned / json.length)}x`.padStart(8)} ${String(json.length).padStart(14)}`,
    );
    timings.push({ json, baseline: baseline.ms, view: view.ms, snapshot: snapshot.ms, repeats });
  }
  console.log(
    "  the baseline pays roughly the same again in JSON.parse of the repaired text; the resumable scanner never reparses",
  );
  console.log("wall clock on this machine (median of the listed repeats, run-dependent — not a property of the code):");
  console.log(
    `  ${"doc chars".padStart(9)} ${"rescan+reparse".padStart(15)} ${"resumable view".padStart(15)}` +
      ` ${"snapshot/frag".padStart(14)} ${"reps".padStart(5)}`,
  );
  for (const row of timings) {
    console.log(
      `  ${String(row.json.length).padStart(9)} ${`${fmt(row.baseline, 2)}ms`.padStart(15)}` +
        ` ${`${fmt(row.view, 2)}ms`.padStart(15)} ${`${fmt(row.snapshot, 2)}ms`.padStart(14)}` +
        ` ${String(row.repeats).padStart(5)}`,
    );
  }

  const huge = makeToolCallJson(1048576, benchSeed);
  const hugeView = replayTimed(huge, benchSeed, 24, "view", 3);
  const hugeScan = baselineScanChars(huge.length, benchSeed, 24);
  console.log(
    `resumable view at ${huge.length} doc chars: ${fmt(hugeView.ms)}ms over ${hugeView.fragments} fragments;` +
      ` the same replay costs the baseline ${hugeScan} scanned chars, ${fmt(hugeScan / huge.length)}x the document` +
      ` (counted exactly, not run)`,
  );
}

async function byteQueueDemo(): Promise<void> {
  console.log("");
  console.log("== 6. byte-budgeted backpressure: where counting chunks stops working ==");
  const seed = 20260901;
  const sizes = heavyTailedSizes(2000, seed);
  const summary = summarizeWorkload(sizes, 4096);
  console.log(
    `workload: ${summary.count} chunks, ${summary.totalBytes} bytes total, sizes ` +
      `${summary.minSize}..${summary.maxSize} bytes (median ${summary.medianSize}, ` +
      `span ${fmt(summary.maxSize / summary.minSize, 0)}x)`,
  );
  console.log(
    `  chunks over 4096 bytes: ${summary.hugeCount} of ${summary.count} ` +
      `(${fmt((100 * summary.hugeCount) / summary.count)}% of chunks, ` +
      `${fmt(100 * summary.hugeByteShare)}% of the bytes)`,
  );

  console.log("");
  console.log("memory high-water by arrival order (steady producer, consumer takes 1 chunk per tick):");
  console.log(`  ${"ordering".padEnd(14)} ${"count cap 8".padStart(12)} ${"byte cap 65536".padStart(15)}`);
  const orderings: { label: string; order: number[] }[] = [
    { label: "as generated", order: sizes },
    { label: "shuffle 1", order: shuffled(sizes, 1) },
    { label: "shuffle 2", order: shuffled(sizes, 2) },
    { label: "shuffle 3", order: shuffled(sizes, 3) },
    { label: "shuffle 4", order: shuffled(sizes, 4) },
    { label: "huge first", order: [...sizes].sort((a, b) => b - a) },
  ];
  for (const { label, order } of orderings) {
    const count8 = await replayThroughQueue(order, { maxItems: 8 });
    const byte64 = await replayThroughQueue(order, { maxBytes: 65536 });
    console.log(
      `  ${label.padEnd(14)} ${`${count8.bytesHighWater} B`.padStart(12)} ${`${byte64.bytesHighWater} B`.padStart(15)}`,
    );
  }
  console.log(
    `  count cap 8 can only promise 8 x ${summary.maxSize} = ${8 * summary.maxSize} bytes;` +
      ` the byte cap promises 65536 under every ordering`,
  );

  console.log("");
  const pacing: ProducerPacing = { burstChunks: 50, gapTicks: 25 };
  console.log(
    `bursty producer (bursts of ${pacing.burstChunks} chunks, ${pacing.gapTicks}-tick gaps), same workload:`,
  );
  console.log(
    `  ${"queue".padEnd(16)} ${"worst-case B".padStart(12)} ${"peak B".padStart(8)}` +
      ` ${"mean buffered B".padStart(15)} ${"idle ticks".padStart(10)} ${"stalls".padStart(7)}`,
  );
  const burstConfigs: { label: string; worstCase: string; run: StudyRun }[] = [
    {
      label: "unbounded",
      worstCase: "none",
      run: await replayThroughQueue(sizes, {}, pacing),
    },
    {
      label: "count cap 8",
      worstCase: String(8 * summary.maxSize),
      run: await replayThroughQueue(sizes, { maxItems: 8 }, pacing),
    },
    {
      label: "count cap 2",
      worstCase: String(2 * summary.maxSize),
      run: await replayThroughQueue(sizes, { maxItems: 2 }, pacing),
    },
    {
      label: "byte cap 65536",
      worstCase: "65536",
      run: await replayThroughQueue(sizes, { maxBytes: 65536 }, pacing),
    },
  ];
  for (const { label, worstCase, run } of burstConfigs) {
    console.log(
      `  ${label.padEnd(16)} ${worstCase.padStart(12)} ${String(run.bytesHighWater).padStart(8)}` +
        ` ${fmt(run.meanBufferedBytes, 0).padStart(15)} ${String(run.consumerIdleTicks).padStart(10)}` +
        ` ${String(run.stalledPushes).padStart(7)}`,
    );
  }
  console.log(
    "  count cap 2 is the only chunk count that matches the byte cap's 64 KB promise, and it" +
      "\n  pays for it in consumer idle ticks; the byte cap holds the same promise with deep run-ahead",
  );

  console.log("");
  const tight = await replayThroughQueue(sizes, { maxBytes: 4096 });
  console.log(
    `budget below the largest chunk: byte cap 4096 admits an oversized chunk only into an empty buffer` +
      `\n  bytes high-water ${tight.bytesHighWater} (= largest chunk, not the budget), oversized admissions ` +
      `${tight.oversizedPushes}, all ${tight.consumed} chunks delivered`,
  );

  const uniform = uniformSizes(2000, seed + 1, 1, 24);
  const uniformCount8 = await replayThroughQueue(uniform, { maxItems: 8 }, pacing);
  const uniformByte192 = await replayThroughQueue(uniform, { maxBytes: 192 }, pacing);
  console.log(
    `uniform control (1..24 byte chunks): count cap 8 peak ${uniformCount8.bytesHighWater} B of its ` +
      `${8 * 24} B worst case,\n  byte cap 192 peak ${uniformByte192.bytesHighWater} B — near-uniform sizes` +
      ` are the case where a chunk count was an honest memory bound`,
  );

  const bytes = scriptedSseBytes();
  const queue = new AsyncQueue<Uint8Array>({ maxBytes: 256, sizeOf: (chunk) => chunk.byteLength });
  const producer = (async () => {
    for await (const chunk of chunkBytes(bytes, { seed: SEED, maxChunkBytes: 24, delayMs: 0 })) {
      await queue.push(chunk);
    }
    queue.close();
  })();
  const piped = await runPipeline(queue, bytes.length);
  await producer;
  const identical = piped.text === ASSISTANT_TEXT && JSON.stringify(piped.toolArgs) === JSON.stringify(TOOL_ARGS);
  console.log(`pipeline behind a 256-byte-capped queue parses the fixture identically: ${identical}`);
  if (!identical) throw new Error("byte-capped pipeline mismatch");
}

function sseLimitDemo(): void {
  console.log("");
  console.log("== 7. sse limits: what a hostile stream costs, and the two failure modes ==");
  const chunk = 1024;
  const lineCap = 65536;

  // The hazard: one data line that never gets a terminator.
  const poisonChars = 4 * 1024 * 1024;
  const poison = unterminatedLineWire(poisonChars);
  const unbounded = replayInChunks(poison, chunk);
  console.log(
    `unterminated ${poisonChars}-char data line in ${chunk}-char chunks, no limits:` +
      ` 0 events, parser retains ${unbounded.retainedCharsHighWater} chars — the whole poison, forever`,
  );
  if (unbounded.events.length !== 0 || unbounded.retainedCharsHighWater !== poison.length) {
    throw new Error("unbounded hazard replay mismatch");
  }

  // Failure mode 1: fail closed.
  const failClosed = replayInChunks(poison, chunk, { maxLineChars: lineCap, onLimit: "error" });
  if (failClosed.error === null) throw new Error("error mode did not fail");
  console.log(
    `maxLineChars ${lineCap}, error mode: SseLimitError("${failClosed.error.kind}") after ` +
      `${failClosed.charsFed} of ${poison.length} chars ` +
      `(${fmt((100 * failClosed.charsFed) / poison.length)}% of the poison), ` +
      `retained high-water ${failClosed.retainedCharsHighWater} chars`,
  );
  if (failClosed.retainedCharsHighWater > lineCap + chunk) {
    throw new Error("error mode exceeded the retention bound");
  }

  // Failure mode 2: skip the poisoned line, keep the stream.
  const mixed =
    normalEventsWire(20, "before") + giantLineEventWire(1024 * 1024) + normalEventsWire(20, "after");
  const mixedUncapped = replayInChunks(mixed, chunk);
  const mixedSkip = replayInChunks(mixed, chunk, { maxLineChars: lineCap, onLimit: "skip" });
  const afterCount = mixedSkip.events.filter((e) => e.data.includes('"tag":"after"')).length;
  console.log(
    `20 events + one ${1024 * 1024}-char line + 20 events: no limits delivers ` +
      `${mixedUncapped.events.length} events at high-water ${mixedUncapped.retainedCharsHighWater};` +
      `\n  skip mode delivers ${mixedSkip.events.length} (all ${afterCount} post-poison events survive),` +
      ` drops ${mixedSkip.droppedLines} line, high-water ${mixedSkip.retainedCharsHighWater}` +
      ` (bound: cap ${lineCap} + chunk ${chunk})`,
  );
  if (
    mixedSkip.events.length !== 40 ||
    afterCount !== 20 ||
    mixedSkip.droppedLines !== 1 ||
    mixedSkip.retainedCharsHighWater > lineCap + chunk
  ) {
    throw new Error("skip mode recovery mismatch");
  }

  // The line cap alone misses accumulation: every line terminates, the event never does.
  const accumulation = manyLineEventWire(2100, 512) + normalEventsWire(5, "tail");
  const accUncapped = replayInChunks(accumulation, chunk);
  const accSkip = replayInChunks(accumulation, chunk, {
    maxLineChars: lineCap,
    maxEventChars: lineCap,
    onLimit: "skip",
  });
  const giant = accUncapped.events[0];
  if (giant === undefined) throw new Error("accumulation control lost its event");
  console.log(
    `2100 short data lines, one event: every line passes a ${lineCap}-char line cap, but the` +
      ` event accumulates\n  ${giant.data.length} chars (no limits, high-water ` +
      `${accUncapped.retainedCharsHighWater}); maxEventChars ${lineCap} in skip mode drops ` +
      `${accSkip.droppedEvents} event,\n  delivers the ${accSkip.events.length} tail events, ` +
      `high-water ${accSkip.retainedCharsHighWater}`,
  );
  if (
    accSkip.droppedEvents !== 1 ||
    accSkip.events.length !== 5 ||
    accSkip.retainedCharsHighWater > 2 * lineCap + chunk
  ) {
    throw new Error("event cap replay mismatch");
  }

  // The caps cost nothing on a well-formed stream: fuzz against the uncapped reference.
  const bytes = scriptedSseBytes();
  const reference = JSON.stringify(parseSseComplete(bytes));
  const seeds = 300;
  let identical = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    const parser = new SseParser({ maxLineChars: lineCap, maxEventChars: lineCap });
    const events = [];
    let prev = 0;
    for (const boundary of chunkOffsets(bytes.length, seed, 17)) {
      events.push(...parser.feed(bytes.subarray(prev, boundary)));
      prev = boundary;
    }
    events.push(...parser.end());
    if (JSON.stringify(events) === reference) identical++;
  }
  console.log(
    `capped parser on the well-formed fixture: ${identical}/${seeds} seeded chunkings` +
      ` byte-identical to the uncapped reference`,
  );
  if (identical !== seeds) throw new Error("capped/uncapped divergence on a well-formed stream");
}

await streamingDemo();
await partialJsonDemo();
await backpressureDemo();
await fuzzDemo();
resumableDemo();
await byteQueueDemo();
sseLimitDemo();
