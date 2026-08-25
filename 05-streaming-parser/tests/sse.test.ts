import { describe, expect, it } from "vitest";
import { SseParser, type SseEvent } from "../src/sse.js";

const encode = (s: string): Uint8Array => new TextEncoder().encode(s);

function parseAll(chunks: Uint8Array[]): SseEvent[] {
  const parser = new SseParser();
  const events: SseEvent[] = [];
  for (const chunk of chunks) events.push(...parser.push(chunk));
  events.push(...parser.end());
  return events;
}

describe("event framing", () => {
  it("parses a single event", () => {
    expect(parseAll([encode("event: ping\ndata: {}\n\n")])).toEqual([
      { event: "ping", data: "{}" },
    ]);
  });

  it("defaults the event name to 'message'", () => {
    expect(parseAll([encode("data: x\n\n")])).toEqual([{ event: "message", data: "x" }]);
  });

  it("joins multiple data lines with newlines", () => {
    expect(parseAll([encode("data: a\ndata: b\n\n")])).toEqual([
      { event: "message", data: "a\nb" },
    ]);
  });

  it("ignores comment lines and unknown fields", () => {
    const stream = ": keep-alive\nid: 7\nretry: 100\ndata: x\n\n";
    expect(parseAll([encode(stream)])).toEqual([{ event: "message", data: "x" }]);
  });

  it("handles CRLF line endings", () => {
    expect(parseAll([encode("event: e\r\ndata: x\r\n\r\n")])).toEqual([
      { event: "e", data: "x" },
    ]);
  });

  it("treats a blank line with no data as a no-op", () => {
    expect(parseAll([encode("\n\nevent: e\n\ndata: x\n\n")])).toEqual([
      { event: "message", data: "x" },
    ]);
  });

  it("does not leak an event name into the next event", () => {
    const stream = "event: first\ndata: 1\n\ndata: 2\n\n";
    expect(parseAll([encode(stream)])).toEqual([
      { event: "first", data: "1" },
      { event: "message", data: "2" },
    ]);
  });

  it("discards an event left unterminated at end of stream", () => {
    expect(parseAll([encode("data: complete\n\ndata: dangl")])).toEqual([
      { event: "message", data: "complete" },
    ]);
  });

  it("returns nothing for an empty stream", () => {
    expect(parseAll([])).toEqual([]);
    expect(parseAll([encode("")])).toEqual([]);
  });
});

describe("chunk boundaries", () => {
  const stream = "event: alpha\ndata: first ✈️ event\n\nevent: beta\ndata: 第二\n\n";
  const expected: SseEvent[] = [
    { event: "alpha", data: "first ✈️ event" },
    { event: "beta", data: "第二" },
  ];

  it("parses identically for every possible two-chunk split, including mid-code-point", () => {
    const bytes = encode(stream);
    for (let cut = 0; cut <= bytes.length; cut++) {
      const events = parseAll([bytes.subarray(0, cut), bytes.subarray(cut)]);
      expect(events).toEqual(expected);
    }
  });

  it("parses identically one byte at a time", () => {
    const bytes = encode(stream);
    const chunks = Array.from(bytes, (b) => Uint8Array.of(b));
    expect(parseAll(chunks)).toEqual(expected);
  });
});
