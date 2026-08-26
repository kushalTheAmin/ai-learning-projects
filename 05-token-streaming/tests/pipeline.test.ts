import { describe, expect, it } from "vitest";
import { chunkBytes, chunkOffsets } from "../src/chunker.js";
import { ASSISTANT_TEXT, TOOL_ARGS, TOOL_NAME, scriptedSseBytes } from "../src/fixture.js";
import { runPipeline } from "../src/pipeline.js";
import { SseParser, parseSseComplete } from "../src/sse.js";

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
