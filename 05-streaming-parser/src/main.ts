/**
 * Runs the experiments and prints their numbers:
 *
 *  1. Chunking robustness — the same scripted stream sliced 54 different
 *     ways must reassemble into byte-identical results.
 *  2. Field earliness — how much of the tool-argument stream must arrive
 *     before each field is readable, partial parsing vs waiting for the end.
 *  3. Re-parse cost — what per-event full-prefix parsing costs as arguments
 *     grow, against a single parse at the end.
 *  4. Backpressure — peak buffered memory for a fast producer against a
 *     slow consumer, unbounded queue vs bounded channel.
 */

import { MessageAssembler, type MessageSnapshot } from "./assemble.js";
import { runBackpressureExperiment, type BackpressureReport } from "./backpressure.js";
import { parsePartialJson } from "./partial-json.js";
import { SseParser } from "./sse.js";
import {
  FLIGHT_SCRIPT,
  buildSseBytes,
  chunkFixed,
  chunkRandomly,
  splitJsonDeltas,
} from "./stream.js";

function streamThrough(chunks: Uint8Array[]): { final: MessageSnapshot; events: number; snapshots: number } {
  const parser = new SseParser();
  const assembler = new MessageAssembler();
  let events = 0;
  let snapshots = 0;
  for (const chunk of chunks) {
    for (const event of parser.push(chunk)) {
      assembler.handle(event);
      assembler.snapshot(); // every intermediate snapshot must be parseable
      events++;
      snapshots++;
    }
  }
  for (const event of parser.end()) {
    assembler.handle(event);
    events++;
  }
  return { final: assembler.snapshot(), events, snapshots };
}

function deepEqualJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function runChunkingRobustness(): void {
  console.log("== 1. chunking robustness ==");
  const bytes = buildSseBytes(FLIGHT_SCRIPT);
  const chunkings: { label: string; chunks: Uint8Array[] }[] = [
    { label: "1 byte", chunks: chunkFixed(bytes, 1) },
    { label: "7 bytes", chunks: chunkFixed(bytes, 7) },
    { label: "64 bytes", chunks: chunkFixed(bytes, 64) },
    { label: "whole stream", chunks: [bytes] },
  ];
  for (let seed = 1; seed <= 50; seed++) {
    chunkings.push({ label: `random seed ${seed}`, chunks: chunkRandomly(bytes, seed, 17) });
  }

  let passed = 0;
  let totalSnapshots = 0;
  for (const { label, chunks } of chunkings) {
    const { final, snapshots } = streamThrough(chunks);
    const call = final.toolCalls[0];
    const ok =
      final.text === FLIGHT_SCRIPT.text &&
      final.done &&
      call !== undefined &&
      call.name === FLIGHT_SCRIPT.toolName &&
      call.argsComplete &&
      deepEqualJson(call.args, FLIGHT_SCRIPT.args);
    if (!ok) throw new Error(`chunking ${label} reassembled a different message`);
    passed++;
    totalSnapshots += snapshots;
  }
  console.log(
    `${passed}/${chunkings.length} chunkings (fixed 1/7/64 bytes, whole stream, ` +
      `50 seeded random) reassembled the identical message: same text, same ` +
      `tool args, ${buildSseBytes(FLIGHT_SCRIPT).length} stream bytes.`,
  );
  console.log(
    `${totalSnapshots} intermediate snapshots taken across all chunkings; ` +
      `every one parsed without error.\n`,
  );
}

type Leaves = Map<string, unknown>;

function flattenLeaves(value: unknown, path: string, into: Leaves): void {
  if (Array.isArray(value)) {
    value.forEach((element, i) => flattenLeaves(element, `${path}[${i}]`, into));
  } else if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      flattenLeaves(child, path === "" ? key : `${path}.${key}`, into);
    }
  } else {
    into.set(path, value);
  }
}

function runFieldEarliness(): void {
  console.log("== 2. field earliness: partial parse vs wait-for-complete ==");
  const argsJson = JSON.stringify(FLIGHT_SCRIPT.args);
  const totalBytes = argsJson.length;
  const deltas = splitJsonDeltas(argsJson, 41, 8);

  const finalLeaves: Leaves = new Map();
  flattenLeaves(FLIGHT_SCRIPT.args, "", finalLeaves);

  const firstVisibleAt = new Map<string, number>();
  const stableAt = new Map<string, number>();

  let received = "";
  for (const delta of deltas) {
    received += delta;
    const snapshot = parsePartialJson(received);
    const leaves: Leaves = new Map();
    flattenLeaves(snapshot.value, "", leaves);
    for (const [path, value] of leaves) {
      if (!finalLeaves.has(path)) continue;
      if (!firstVisibleAt.has(path)) firstVisibleAt.set(path, received.length);
      if (!stableAt.has(path) && deepEqualJson(value, finalLeaves.get(path))) {
        stableAt.set(path, received.length);
      }
    }
  }

  const pct = (bytes: number): string => `${((100 * bytes) / totalBytes).toFixed(1)}%`;
  console.log(
    `tool args: ${totalBytes} bytes of JSON over ${deltas.length} delta events. ` +
      `A wait-for-complete client reads every field at 100.0%.`,
  );
  console.log(`${"field".padEnd(28)} ${"visible at".padStart(11)} ${"final at".padStart(10)}`);
  for (const path of finalLeaves.keys()) {
    const visible = firstVisibleAt.get(path);
    const stable = stableAt.get(path);
    if (visible === undefined || stable === undefined) {
      throw new Error(`field ${path} never became readable`);
    }
    console.log(`${path.padEnd(28)} ${pct(visible).padStart(11)} ${pct(stable).padStart(10)}`);
  }
  const meanStable =
    [...stableAt.values()].reduce((sum, bytes) => sum + bytes, 0) / stableAt.size;
  console.log(
    `mean field final at ${pct(meanStable)} of the argument stream — ` +
      `the rest of the wait is what partial parsing removes.\n`,
  );
}

function makeLargeArgsJson(items: number): string {
  const rows = Array.from({ length: items }, (_, i) => ({
    id: i,
    sku: `ITEM-${i.toString().padStart(5, "0")}`,
    quantity: (i % 7) + 1,
    tags: ["alpha", "beta"],
  }));
  return JSON.stringify({ order: { rows } });
}

function runReparseCost(): void {
  console.log("== 3. cost of incremental readability (full-prefix re-parse) ==");
  console.log(
    `${"arg bytes".padStart(10)} ${"events".padStart(7)} ${"re-parse total".padStart(15)} ` +
      `${"single parse".padStart(13)} ${"overhead".padStart(9)}`,
  );
  for (const items of [10, 100, 1000]) {
    const json = makeLargeArgsJson(items);
    const deltas = splitJsonDeltas(json, 7, 8);

    const startedIncremental = performance.now();
    let received = "";
    for (const delta of deltas) {
      received += delta;
      parsePartialJson(received);
    }
    const incrementalMs = performance.now() - startedIncremental;

    const startedSingle = performance.now();
    parsePartialJson(json);
    const singleMs = performance.now() - startedSingle;

    const overhead = incrementalMs / Math.max(singleMs, 0.001);
    console.log(
      `${json.length.toString().padStart(10)} ${deltas.length.toString().padStart(7)} ` +
        `${incrementalMs.toFixed(1).padStart(13)}ms ${singleMs.toFixed(2).padStart(11)}ms ` +
        `${overhead.toFixed(0).padStart(8)}x`,
    );
  }
  console.log(
    "re-parsing the whole prefix on every delta is O(n^2) in stream length — " +
      "fine at tool-call sizes, measurable at 10x, prohibitive at 100x.\n",
  );
}

async function runBackpressure(): Promise<void> {
  console.log("== 4. backpressure: unbounded queue vs bounded channel ==");
  const streamBytes = buildSseBytes(FLIGHT_SCRIPT);
  const base = chunkFixed(streamBytes, 64);
  const chunks: Uint8Array[] = [];
  while (chunks.length < 5000) chunks.push(...base);

  const reports: BackpressureReport[] = [];
  reports.push(await runBackpressureExperiment("unbounded", chunks, Infinity));
  reports.push(await runBackpressureExperiment("bounded cap=64", chunks, 64));
  reports.push(await runBackpressureExperiment("bounded cap=8", chunks, 8));
  reports.push(await runBackpressureExperiment("bounded cap=1", chunks, 1));

  console.log(
    `${chunks.length} chunks (~64 B each), instant producer, consumer yields per chunk.`,
  );
  console.log(
    `${"policy".padEnd(16)} ${"peak items".padStart(10)} ${"peak KB".padStart(8)} ` +
      `${"blocked pushes".padStart(14)} ${"wall ms".padStart(8)}`,
  );
  for (const r of reports) {
    console.log(
      `${r.policy.padEnd(16)} ${r.peakBufferedItems.toString().padStart(10)} ` +
        `${(r.peakBufferedBytes / 1024).toFixed(1).padStart(8)} ` +
        `${r.blockedPushes.toString().padStart(14)} ${r.wallMs.toFixed(0).padStart(8)}`,
    );
    if (r.itemsProcessed !== chunks.length) {
      throw new Error(`${r.policy}: processed ${r.itemsProcessed}/${chunks.length}`);
    }
  }
  console.log(
    "throughput is consumer-bound either way — bounding the channel trades " +
      "none of it, it only caps how much memory the producer's burst can pin.\n",
  );
}

runChunkingRobustness();
runFieldEarliness();
runReparseCost();
await runBackpressure();
