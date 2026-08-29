import { describe, expect, it } from "vitest";
import { SseParser } from "../../05-token-streaming/src/sse.js";
import { chunkOffsets } from "../../05-token-streaming/src/chunker.js";
import { serializeEvent, streamEvents, writeEvent, type StreamSink, type WireEvent } from "../src/stream.js";
import { runSlowClient } from "../src/backpressure.js";

const DECODER = new TextDecoder();

describe("serializeEvent", () => {
  it("produces the exact wire form for a named event", () => {
    const wire = DECODER.decode(serializeEvent({ event: "token", data: '{"text":"hi "}' }));
    expect(wire).toBe('event: token\ndata: {"text":"hi "}\n\n');
  });

  it("omits the event line when no name is given", () => {
    expect(DECODER.decode(serializeEvent({ data: "x" }))).toBe("data: x\n\n");
  });

  it("splits multi-line data into one data line per line", () => {
    expect(DECODER.decode(serializeEvent({ data: "a\nb" }))).toBe("data: a\ndata: b\n\n");
  });
});

describe("wire round trip through 05's parser", () => {
  const events: WireEvent[] = [
    { event: "meta", data: JSON.stringify({ requestId: "r0001", retrieved: ["pg-backups"] }) },
    { event: "token", data: JSON.stringify({ text: "Base " }) },
    { event: "token", data: JSON.stringify({ text: "backups café 02:30 " }) },
    { event: "done", data: JSON.stringify({ outcome: "answered" }) },
  ];

  it("survives arbitrary chunk boundaries, multi-byte characters included", () => {
    const wire = events.map((event) => serializeEvent(event));
    const total = new Uint8Array(wire.reduce((acc, part) => acc + part.length, 0));
    let offset = 0;
    for (const part of wire) {
      total.set(part, offset);
      offset += part.length;
    }
    for (let seed = 1; seed <= 30; seed++) {
      const parser = new SseParser();
      const received: { event: string; data: string }[] = [];
      const offsets = chunkOffsets(total.length, seed, 5);
      let start = 0;
      for (const end of offsets) {
        for (const parsed of parser.feed(total.slice(start, end))) {
          received.push({ event: parsed.event, data: parsed.data });
        }
        start = end;
      }
      for (const parsed of parser.end()) received.push({ event: parsed.event, data: parsed.data });
      expect(received).toEqual(events.map((e) => ({ event: e.event, data: e.data })));
    }
  });
});

describe("writeEvent", () => {
  it("waits for drain when the sink reports a full buffer", async () => {
    const order: string[] = [];
    let drainResolve: (() => void) | undefined;
    const sink: StreamSink = {
      write: () => {
        order.push("write");
        return false;
      },
      waitDrain: () =>
        new Promise((resolve) => {
          order.push("wait");
          drainResolve = resolve;
        }),
    };
    const pending = writeEvent(sink, { event: "token", data: "x" });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(order).toEqual(["write", "wait"]);
    expect(settled).toBe(false);
    drainResolve!();
    await pending;
    expect(settled).toBe(true);
  });

  it("does not wait when the sink accepts the write", async () => {
    const sink: StreamSink = {
      write: () => true,
      waitDrain: () => {
        throw new Error("must not be called");
      },
    };
    const bytes = await writeEvent(sink, { event: "token", data: "x" });
    expect(bytes).toBe(serializeEvent({ event: "token", data: "x" }).length);
  });
});

describe("streamEvents", () => {
  const makeEvents = (n: number): WireEvent[] =>
    Array.from({ length: n }, (_, i) => ({ event: "token", data: JSON.stringify({ text: `t${i} ` }) }));

  it("delivers every event and counts exact bytes", async () => {
    const events = makeEvents(10);
    const written: Uint8Array[] = [];
    const sink: StreamSink = {
      write: (chunk) => {
        written.push(chunk);
        return true;
      },
      waitDrain: () => Promise.resolve(),
    };
    const result = await streamEvents(events, sink, 8);
    expect(result.events).toBe(10);
    const expectedBytes = events.reduce((acc, event) => acc + serializeEvent(event).length, 0);
    expect(result.bytes).toBe(expectedBytes);
    expect(written).toHaveLength(10);
  });

  it("completes an empty stream without hanging", async () => {
    const sink: StreamSink = { write: () => true, waitDrain: () => Promise.resolve() };
    const result = await streamEvents([], sink, 4);
    expect(result.events).toBe(0);
    expect(result.bytes).toBe(0);
  });

  it("caps buffering at the queue capacity against a slow client", async () => {
    const run = await runSlowClient("bounded", makeEvents(20), 4);
    expect(run.events).toBe(20);
    expect(run.highWaterItems).toBe(4);
    expect(run.stalledPushes).toBeGreaterThan(0);
  });

  it("buffers nearly the whole stream when unbounded against the same client", async () => {
    const run = await runSlowClient("unbounded", makeEvents(20), Infinity);
    expect(run.events).toBe(20);
    expect(run.highWaterItems).toBeGreaterThanOrEqual(18);
    expect(run.stalledPushes).toBe(0);
  });
});
