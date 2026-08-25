import { describe, expect, it } from "vitest";
import { MessageAssembler } from "../src/assemble.js";
import { SseParser } from "../src/sse.js";
import {
  FLIGHT_SCRIPT,
  buildSseBytes,
  chunkFixed,
  chunkRandomly,
  splitJsonDeltas,
  splitTextDeltas,
} from "../src/stream.js";

function reassemble(chunks: Uint8Array[]) {
  const parser = new SseParser();
  const assembler = new MessageAssembler();
  const partialTexts: string[] = [];
  for (const chunk of chunks) {
    for (const event of parser.push(chunk)) {
      assembler.handle(event);
      partialTexts.push(assembler.snapshot().text);
    }
  }
  for (const event of parser.end()) assembler.handle(event);
  return { final: assembler.snapshot(), partialTexts };
}

describe("scripted stream building blocks", () => {
  it("text deltas concatenate back to the original text", () => {
    expect(splitTextDeltas(FLIGHT_SCRIPT.text).join("")).toBe(FLIGHT_SCRIPT.text);
  });

  it("json deltas concatenate back to the original json", () => {
    const json = JSON.stringify(FLIGHT_SCRIPT.args);
    expect(splitJsonDeltas(json, 41, 8).join("")).toBe(json);
    expect(splitJsonDeltas(json, 99, 3).join("")).toBe(json);
  });

  it("empty text produces no deltas", () => {
    expect(splitTextDeltas("")).toEqual([]);
  });

  it("chunkers are exhaustive and deterministic", () => {
    const bytes = buildSseBytes(FLIGHT_SCRIPT);
    const fixed = chunkFixed(bytes, 7);
    expect(fixed.reduce((sum, c) => sum + c.length, 0)).toBe(bytes.length);
    const a = chunkRandomly(bytes, 5, 13);
    const b = chunkRandomly(bytes, 5, 13);
    expect(a.map((c) => c.length)).toEqual(b.map((c) => c.length));
    expect(a.reduce((sum, c) => sum + c.length, 0)).toBe(bytes.length);
  });
});

describe("full path: bytes -> SSE -> assembler -> message", () => {
  const bytes = buildSseBytes(FLIGHT_SCRIPT);

  it.each([[1], [3], [64], [bytes.length]])(
    "reassembles the exact message at chunk size %i",
    (size) => {
      const { final } = reassemble(chunkFixed(bytes, size));
      expect(final.done).toBe(true);
      expect(final.text).toBe(FLIGHT_SCRIPT.text);
      expect(final.toolCalls).toHaveLength(1);
      const call = final.toolCalls[0];
      expect(call?.name).toBe(FLIGHT_SCRIPT.toolName);
      expect(call?.argsComplete).toBe(true);
      expect(call?.args).toEqual(FLIGHT_SCRIPT.args);
    },
  );

  it("reassembles the exact message under seeded random chunking", () => {
    for (const seed of [1, 2, 3]) {
      const { final } = reassemble(chunkRandomly(bytes, seed, 11));
      expect(final.text).toBe(FLIGHT_SCRIPT.text);
      expect(final.toolCalls[0]?.args).toEqual(FLIGHT_SCRIPT.args);
    }
  });

  it("streams text monotonically — each snapshot extends the last", () => {
    const { partialTexts } = reassemble(chunkFixed(bytes, 16));
    let previous = "";
    for (const text of partialTexts) {
      expect(text.startsWith(previous)).toBe(true);
      previous = text;
    }
    expect(previous).toBe(FLIGHT_SCRIPT.text);
  });

  it("every intermediate tool-arg snapshot is a subset of the final args", () => {
    const parser = new SseParser();
    const assembler = new MessageAssembler();
    for (const chunk of chunkFixed(bytes, 5)) {
      for (const event of parser.push(chunk)) {
        assembler.handle(event);
        const call = assembler.snapshot().toolCalls[0];
        if (call === undefined || call.args === undefined) continue;
        // Every key present in a partial snapshot must exist in the script.
        const partial = call.args as Record<string, unknown>;
        const finalArgs = FLIGHT_SCRIPT.args as Record<string, unknown>;
        for (const key of Object.keys(partial)) {
          expect(finalArgs).toHaveProperty(key);
        }
      }
    }
  });

  it("rejects a stream with corrupted arg deltas", () => {
    const assembler = new MessageAssembler();
    assembler.handle({
      event: "content_block_start",
      data: JSON.stringify({ index: 0, content_block: { type: "tool_use", name: "t" } }),
    });
    assembler.handle({
      event: "content_block_delta",
      data: JSON.stringify({ index: 0, delta: { type: "input_json_delta", partial_json: "{oops" } }),
    });
    expect(() => assembler.snapshot()).toThrow();
  });

  it("rejects deltas for a block that was never opened", () => {
    const assembler = new MessageAssembler();
    expect(() =>
      assembler.handle({
        event: "content_block_delta",
        data: JSON.stringify({ index: 3, delta: { type: "text_delta", text: "x" } }),
      }),
    ).toThrow(/unopened/);
  });
});
