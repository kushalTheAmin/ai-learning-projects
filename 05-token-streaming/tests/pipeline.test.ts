import { describe, expect, it } from "vitest";
import { chunkBytes, chunkOffsets } from "../src/chunker.js";
import { ASSISTANT_TEXT, TOOL_ARGS, TOOL_NAME, scriptedSseBytes } from "../src/fixture.js";
import { runPipeline } from "../src/pipeline.js";
import { SseParser, parseSseComplete } from "../src/sse.js";

/** SSE wire bytes for one tool call whose arguments are `args`, cut into
 *  fragments of `fragmentSize` characters. */
function sseWireForArgs(args: string, fragmentSize: number): Uint8Array {
  let wire = `event: tool_call_start\ndata: ${JSON.stringify({
    type: "tool_call_start",
    name: "t",
  })}\n\n`;
  for (let i = 0; i < args.length; i += fragmentSize) {
    const payload = { type: "tool_args_delta", fragment: args.slice(i, i + fragmentSize) };
    wire += `event: tool_args_delta\ndata: ${JSON.stringify(payload)}\n\n`;
  }
  wire += "data: [DONE]\n\n";
  return new TextEncoder().encode(wire);
}

async function* oneChunk(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

describe("pipeline end to end", () => {
  it("reassembles the scripted turn exactly from tiny chunks", async () => {
    const bytes = scriptedSseBytes();
    const result = await runPipeline(
      chunkBytes(bytes, { seed: 42, maxChunkBytes: 7, delayMs: 0 }),
      bytes.length,
    );
    expect(result.text).toBe(ASSISTANT_TEXT);
    expect(result.toolName).toBe(TOOL_NAME);
    expect(result.toolArgs).toEqual(TOOL_ARGS);
    expect(result.byteCount).toBe(bytes.length);
    expect(result.events).toEqual(parseSseComplete(bytes));
  });

  it("yields a usable snapshot for every argument fragment", async () => {
    const bytes = scriptedSseBytes();
    const result = await runPipeline(
      chunkBytes(bytes, { seed: 7, maxChunkBytes: 16, delayMs: 0 }),
      bytes.length,
    );
    expect(result.argSnapshots.length).toBeGreaterThan(0);
    for (const snapshot of result.argSnapshots) {
      expect(snapshot.status).not.toBe("unparseable");
    }
    const last = result.argSnapshots[result.argSnapshots.length - 1];
    expect(last).toEqual({ status: "complete", value: TOOL_ARGS });
  });

  it("reports fields available in document order, all before end of stream", async () => {
    const bytes = scriptedSseBytes();
    const result = await runPipeline(
      chunkBytes(bytes, { seed: 3, maxChunkBytes: 12, delayMs: 0 }),
      bytes.length,
    );
    const fields = result.fieldAvailability.map((f) => f.field);
    expect(fields).toEqual(Object.keys(TOOL_ARGS));
    let previous = 0;
    for (const { availableAtByteFraction } of result.fieldAvailability) {
      expect(availableAtByteFraction).toBeGreaterThanOrEqual(previous);
      expect(availableAtByteFraction).toBeLessThan(1);
      previous = availableAtByteFraction;
    }
  });

  it("separates when a field first parses from when it first carries a value", async () => {
    const bytes = scriptedSseBytes();
    const result = await runPipeline(
      chunkBytes(bytes, { seed: 3, maxChunkBytes: 12, delayMs: 0 }),
      bytes.length,
    );
    const byField = new Map(result.fieldAvailability.map((f) => [f.field, f]));

    // `filters` is an object, so it parses as `{}` the moment its key gets a
    // value position — before any of its own keys have arrived. Reporting it
    // as available there would say a dispatcher can read the filters when
    // what it can read is an empty object.
    const filters = byField.get("filters");
    expect(filters).toBeDefined();
    expect(filters?.nonEmptyAtByteFraction).not.toBeNull();
    expect(filters?.nonEmptyAtByteFraction as number).toBeGreaterThan(
      filters?.availableAtByteFraction as number,
    );

    // Scalars are whole the instant they parse, so the two coincide there.
    for (const field of ["top_k", "include_snippets"]) {
      const entry = byField.get(field);
      expect(entry?.nonEmptyAtByteFraction).toBe(entry?.availableAtByteFraction);
    }
  });

  it("reports no value-carrying point for a field that stays empty", async () => {
    // A field whose final value is "" or [] never carries anything, so there
    // is no honest fraction to report for it.
    const wire = sseWireForArgs('{"blank":"","none":[],"held":"x"}', 5);
    const result = await runPipeline(oneChunk(wire), wire.length);
    const byField = new Map(result.fieldAvailability.map((f) => [f.field, f]));

    expect(byField.get("blank")?.nonEmptyAtByteFraction).toBeNull();
    expect(byField.get("none")?.nonEmptyAtByteFraction).toBeNull();
    expect(byField.get("held")?.nonEmptyAtByteFraction).toBe(
      byField.get("held")?.availableAtByteFraction,
    );
    // All three still parsed, so the first-parse column is unaffected.
    expect([...byField.keys()]).toEqual(["blank", "none", "held"]);
  });

  it("records a first-text time no later than the total time", async () => {
    const bytes = scriptedSseBytes();
    const result = await runPipeline(
      chunkBytes(bytes, { seed: 11, maxChunkBytes: 24, delayMs: 1 }),
      bytes.length,
    );
    expect(result.timeToFirstTextMs).not.toBeNull();
    expect(result.timeToFirstTextMs as number).toBeLessThan(result.totalMs);
  });
});

describe("chunk-boundary fuzz", () => {
  it("parses identically under 200 random byte-level chunkings", () => {
    const bytes = scriptedSseBytes();
    const reference = JSON.stringify(parseSseComplete(bytes));
    for (let seed = 1; seed <= 200; seed++) {
      const parser = new SseParser();
      const events = [];
      let prev = 0;
      for (const boundary of chunkOffsets(bytes.length, seed, 13)) {
        events.push(...parser.feed(bytes.subarray(prev, boundary)));
        prev = boundary;
      }
      events.push(...parser.end());
      expect(JSON.stringify(events), `seed ${seed}`).toBe(reference);
    }
  });

  it("parses a mixed CRLF/CR/LF wire identically under 100 random chunkings", () => {
    // The scripted fixture is LF-only, so fuzz the CR paths on their own wire.
    const wire =
      "event: a\r\ndata: one\r\n\r\n" +
      "data: two\rdata: café ☀️\r\r" +
      "id: 9\ndata: three\n\n";
    const bytes = new TextEncoder().encode(wire);
    const reference = JSON.stringify(parseSseComplete(bytes));
    for (let seed = 1; seed <= 100; seed++) {
      const parser = new SseParser();
      const events = [];
      let prev = 0;
      for (const boundary of chunkOffsets(bytes.length, seed, 5)) {
        events.push(...parser.feed(bytes.subarray(prev, boundary)));
        prev = boundary;
      }
      events.push(...parser.end());
      expect(JSON.stringify(events), `seed ${seed}`).toBe(reference);
    }
  });

  it("covers the degenerate single-byte chunking", () => {
    const bytes = scriptedSseBytes();
    const parser = new SseParser();
    const events = [];
    for (const byte of bytes) {
      events.push(...parser.feed(new Uint8Array([byte])));
    }
    events.push(...parser.end());
    expect(events).toEqual(parseSseComplete(bytes));
  });
});
