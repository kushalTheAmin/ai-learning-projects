import { describe, expect, it } from "vitest";
import { SseParser, SseLimitError, parseSseComplete, type SseEvent, type SseLimits } from "../src/sse.js";
import {
  normalEventsWire,
  giantLineEventWire,
  unterminatedLineWire,
  manyLineEventWire,
  replayInChunks,
} from "../src/sseLimitStudy.js";

const enc = new TextEncoder();

function parseAll(wire: string, limits?: SseLimits): SseEvent[] {
  const parser = new SseParser(limits);
  return [...parser.feed(enc.encode(wire)), ...parser.end()];
}

function dataOf(events: SseEvent[]): string[] {
  return events.map((e) => e.data);
}

describe("limit validation", () => {
  it("rejects non-positive and non-integer caps", () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity]) {
      expect(() => new SseParser({ maxLineChars: bad })).toThrow(RangeError);
      expect(() => new SseParser({ maxEventChars: bad })).toThrow(RangeError);
    }
  });

  it("stays unlimited with no limits given", () => {
    const line = "x".repeat(100_000);
    const events = parseAll(`data: ${line}\n\n`);
    expect(events[0]?.data).toBe(line);
    const parser = new SseParser();
    parser.feed(enc.encode(`data: ${line}`));
    expect(parser.stats.retainedCharsHighWater).toBeGreaterThanOrEqual(100_000);
    expect(parser.stats.droppedLines).toBe(0);
  });
});

describe("line cap, error mode (the default)", () => {
  it("throws once the incomplete line crosses the cap, and stays poisoned", () => {
    const parser = new SseParser({ maxLineChars: 8 });
    expect(parser.feed(enc.encode("data: a"))).toEqual([]); // 7 chars, under cap
    expect(() => parser.feed(enc.encode("ab"))).toThrow(SseLimitError);
    expect(() => parser.feed(enc.encode("x"))).toThrow(SseLimitError);
    expect(() => parser.end()).toThrow(SseLimitError);
  });

  it("throws on an over-cap line completed within one feed", () => {
    expect(() => parseAll("data: hi\n\n", { maxLineChars: 6 })).toThrow(SseLimitError);
  });

  it("names the kind, the limit, and the observed size", () => {
    try {
      parseAll("data: 123456789\n\n", { maxLineChars: 10 });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SseLimitError);
      const limitError = error as SseLimitError;
      expect(limitError.kind).toBe("line");
      expect(limitError.limit).toBe(10);
      expect(limitError.observed).toBe(15);
    }
  });

  it("passes a line of exactly the cap", () => {
    // "data: x" is 7 chars
    expect(parseAll("data: x\n\n", { maxLineChars: 7 })[0]?.data).toBe("x");
    expect(() => parseAll("data: x\n\n", { maxLineChars: 6 })).toThrow(SseLimitError);
  });

  it("does not count a trailing CR at a chunk boundary toward the line", () => {
    const parser = new SseParser({ maxLineChars: 7 });
    const events = [
      ...parser.feed(enc.encode("data: x\r")), // line is 7 chars + unclassified CR
      ...parser.feed(enc.encode("\n\n")),
      ...parser.end(),
    ];
    expect(events[0]?.data).toBe("x");
  });
});

describe("line cap, skip mode", () => {
  it("drops an over-cap completed line and keeps the rest of the stream", () => {
    const wire = `data: ${"z".repeat(20)}\ndata: ok\n\n`;
    const events = parseAll(wire, { maxLineChars: 16, onLimit: "skip" });
    expect(dataOf(events)).toEqual(["ok"]);
  });

  it("drops a poisoned line inside an event without losing its other data lines", () => {
    const wire = `data: a\ndata: ${"z".repeat(20)}\ndata: b\n\n`;
    const parser = new SseParser({ maxLineChars: 16, onLimit: "skip" });
    const events = [...parser.feed(enc.encode(wire)), ...parser.end()];
    expect(dataOf(events)).toEqual(["a\nb"]);
    expect(parser.stats.droppedLines).toBe(1);
  });

  it("counts a multi-chunk unterminated line once and recovers at its terminator", () => {
    const parser = new SseParser({ maxLineChars: 8, onLimit: "skip" });
    const events: SseEvent[] = [];
    events.push(...parser.feed(enc.encode("data: aaaaaa"))); // 12 > 8: enter discard
    events.push(...parser.feed(enc.encode("bbbbbb"))); // still the same line
    events.push(...parser.feed(enc.encode("cc\ndata: ok\n\n")));
    events.push(...parser.end());
    expect(dataOf(events)).toEqual(["ok"]);
    expect(parser.stats.droppedLines).toBe(1);
    expect(parser.stats.retainedCharsHighWater).toBeLessThanOrEqual(8 + 14);
  });

  it("handles a CRLF split across feeds while discarding", () => {
    const parser = new SseParser({ maxLineChars: 8, onLimit: "skip" });
    const events: SseEvent[] = [];
    events.push(...parser.feed(enc.encode("data: toolongline")));
    events.push(...parser.feed(enc.encode("junk\r")));
    events.push(...parser.feed(enc.encode("\ndata: ok\n\n")));
    events.push(...parser.end());
    expect(dataOf(events)).toEqual(["ok"]);
    expect(parser.stats.droppedLines).toBe(1);
  });

  it("treats a bare CR while discarding as the line's end", () => {
    const parser = new SseParser({ maxLineChars: 8, onLimit: "skip" });
    const events: SseEvent[] = [];
    events.push(...parser.feed(enc.encode("data: toolongline")));
    events.push(...parser.feed(enc.encode("junk\r")));
    events.push(...parser.feed(enc.encode("data: ok\n\n")));
    events.push(...parser.end());
    expect(dataOf(events)).toEqual(["ok"]);
  });

  it("keeps the pending-LF swallow across an empty feed", () => {
    const parser = new SseParser({ maxLineChars: 8, onLimit: "skip" });
    const events: SseEvent[] = [];
    events.push(...parser.feed(enc.encode("data: toolongline")));
    events.push(...parser.feed(enc.encode("junk\r")));
    events.push(...parser.feed(new Uint8Array(0)));
    events.push(...parser.feed(enc.encode("\ndata: ok\n\n")));
    events.push(...parser.end());
    expect(dataOf(events)).toEqual(["ok"]);
    expect(parser.stats.droppedLines).toBe(1);
  });

  it("drops an over-cap completed line ending on a chunk-boundary CR without eating the next line", () => {
    const parser = new SseParser({ maxLineChars: 8, onLimit: "skip" });
    const events: SseEvent[] = [];
    events.push(...parser.feed(enc.encode("data: toolongline\r")));
    events.push(...parser.feed(enc.encode("\ndata: ok\n\n")));
    events.push(...parser.end());
    expect(dataOf(events)).toEqual(["ok"]);
    expect(parser.stats.droppedLines).toBe(1);
  });

  it("falls back to the message type when the event: line is dropped", () => {
    const wire = "event: superlongtypename\ndata: x\n\n";
    const events = parseAll(wire, { maxLineChars: 12, onLimit: "skip" });
    expect(events).toEqual([{ event: "message", data: "x", id: undefined, retry: undefined }]);
  });

  it("ends cleanly while a discarded line is still open", () => {
    const parser = new SseParser({ maxLineChars: 8, onLimit: "skip" });
    parser.feed(enc.encode("data: waytoolongandnoterminator"));
    expect(parser.end()).toEqual([]);
    expect(parser.stats.droppedLines).toBe(1);
  });
});

describe("event cap", () => {
  const twoLines = "data: 123456\ndata: 123456\n\n"; // 6 + 1 join + 6 = 13 accumulated

  it("dispatches an event of exactly the cap", () => {
    const events = parseAll("data: 1234\ndata: 5678\n\n", { maxEventChars: 9 });
    expect(events[0]?.data).toBe("1234\n5678");
  });

  it("throws in error mode when accumulated data crosses the cap", () => {
    try {
      parseAll(twoLines, { maxEventChars: 10 });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SseLimitError);
      expect((error as SseLimitError).kind).toBe("event");
      expect((error as SseLimitError).observed).toBe(13);
    }
  });

  it("drops the whole event in skip mode and delivers the next one", () => {
    const parser = new SseParser({ maxEventChars: 10, onLimit: "skip" });
    const events = [...parser.feed(enc.encode(twoLines + "data: ok\n\n")), ...parser.end()];
    expect(dataOf(events)).toEqual(["ok"]);
    expect(parser.stats.droppedEvents).toBe(1);
    expect(parser.stats.droppedLines).toBe(0);
  });

  it("counts an overflowed event once however many data lines follow it", () => {
    const wire = "data: 123456\ndata: 123456\ndata: 78\ndata: 90\n\ndata: ok\n\n";
    const parser = new SseParser({ maxEventChars: 10, onLimit: "skip" });
    const events = [...parser.feed(enc.encode(wire)), ...parser.end()];
    expect(dataOf(events)).toEqual(["ok"]);
    expect(parser.stats.droppedEvents).toBe(1);
  });

  it("bounds accumulation across terminated lines that a line cap alone misses", () => {
    const wire = manyLineEventWire(2100, 512) + "data: tail\n\n";
    const run = replayInChunks(wire, 1024, {
      maxLineChars: 65536,
      maxEventChars: 65536,
      onLimit: "skip",
    });
    expect(run.droppedEvents).toBe(1);
    expect(dataOf(run.events)).toEqual(["tail"]);
    expect(run.retainedCharsHighWater).toBeLessThanOrEqual(65536 + 65536 + 1024);
    const uncapped = replayInChunks(wire, 1024);
    expect(uncapped.retainedCharsHighWater).toBeGreaterThan(1_000_000);
  });
});

describe("limits measure UTF-16 code units", () => {
  it("counts an astral emoji as two units", () => {
    // "data: " (6) + two emoji (2 units each) = 10
    const wire = "data: 😀😀\n\n";
    expect(parseAll(wire, { maxLineChars: 10 })[0]?.data).toBe("😀😀");
    const dropped = parseAll(wire, { maxLineChars: 9, onLimit: "skip" });
    expect(dropped).toEqual([]);
  });

  it("counts decoded units when the emoji's bytes split across feeds", () => {
    const bytes = enc.encode("data: 😀\n\n"); // line is 8 code units, 10 bytes + 2 newlines
    const parser = new SseParser({ maxLineChars: 8 });
    const events: SseEvent[] = [];
    events.push(...parser.feed(bytes.subarray(0, 8))); // splits the 4-byte emoji
    events.push(...parser.feed(bytes.subarray(8)));
    events.push(...parser.end());
    expect(events[0]?.data).toBe("😀");
  });
});

describe("capped parsing is free on well-formed streams", () => {
  const generous: SseLimits = { maxLineChars: 1 << 20, maxEventChars: 1 << 20 };
  const wire =
    'event: delta\nid: 1\ndata: {"text":"héllo ☀️"}\n\n' +
    ": comment\r\ndata: second\rdata: third\r\n\r\n" +
    "data: [DONE]\n\n";

  it("matches the uncapped parser on a mixed-endings wire", () => {
    expect(parseAll(wire, generous)).toEqual(parseAll(wire));
  });

  it("matches byte-by-byte", () => {
    const parser = new SseParser(generous);
    const events: SseEvent[] = [];
    for (const byte of enc.encode(wire)) {
      events.push(...parser.feed(new Uint8Array([byte])));
    }
    events.push(...parser.end());
    expect(events).toEqual(parseAll(wire));
  });
});

describe("replay study rig", () => {
  it("reports a fail-closed replay's error and where it stopped", () => {
    const run = replayInChunks(unterminatedLineWire(4096), 256, { maxLineChars: 1024 });
    expect(run.error?.kind).toBe("line");
    expect(run.events).toEqual([]);
    // overflow fires on the first chunk that pushes the line past 1024 chars
    expect(run.charsFed).toBe(1280);
    expect(run.retainedCharsHighWater).toBeLessThanOrEqual(1024 + 256);
  });

  it("holds the retention bound and delivers every healthy event in skip mode", () => {
    const wire = normalEventsWire(5, "before") + giantLineEventWire(16384) + normalEventsWire(5, "after");
    const run = replayInChunks(wire, 256, { maxLineChars: 1024, onLimit: "skip" });
    expect(run.error).toBeNull();
    expect(run.events).toHaveLength(10);
    expect(run.events.filter((e) => e.data.includes('"tag":"after"'))).toHaveLength(5);
    expect(run.droppedLines).toBe(1);
    expect(run.retainedCharsHighWater).toBeLessThanOrEqual(1024 + 256);
    const uncapped = replayInChunks(wire, 256);
    expect(uncapped.events).toHaveLength(11);
    expect(uncapped.retainedCharsHighWater).toBeGreaterThan(16384);
  });

  it("keeps parseSseComplete unlimited", () => {
    const line = "x".repeat(50_000);
    expect(parseSseComplete(enc.encode(`data: ${line}\n\n`))[0]?.data).toBe(line);
  });
});
