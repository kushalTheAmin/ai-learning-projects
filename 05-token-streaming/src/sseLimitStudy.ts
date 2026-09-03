/**
 * Measurement rig for the SSE limit study: authored hostile streams (a line
 * that never terminates, a giant terminated line, an event that accumulates
 * data lines forever) and a replay harness that feeds a wire through a
 * parser in fixed-size chunks and reports what the parser retained, dropped,
 * or died on. Every wire here is pure ASCII, so chars and bytes coincide and
 * the reported numbers reproduce exactly.
 */

import { SseParser, SseLimitError, type SseEvent, type SseLimits } from "./sse.js";

export interface ReplayResult {
  events: SseEvent[];
  /** Chars fed before the replay finished or the parser threw. */
  charsFed: number;
  totalChars: number;
  /** The limit error that stopped the replay, null when it ran to the end. */
  error: SseLimitError | null;
  droppedLines: number;
  droppedEvents: number;
  retainedCharsHighWater: number;
}

/** `count` small well-formed events, each tagged so survivors are checkable. */
export function normalEventsWire(count: number, tag: string): string {
  let wire = "";
  for (let i = 0; i < count; i++) {
    wire += `event: delta\ndata: {"seq":${i},"tag":"${tag}"}\n\n`;
  }
  return wire;
}

/** One complete event whose single data line is `chars` long. */
export function giantLineEventWire(chars: number): string {
  return `data: ${"x".repeat(chars)}\n\n`;
}

/** A data line that never gets a terminator: the unbounded-buffer attack. */
export function unterminatedLineWire(chars: number): string {
  return `data: ${"x".repeat(chars)}`;
}

/** One event of `lines` short data lines: unbounded accumulation with every line terminated. */
export function manyLineEventWire(lines: number, lineChars: number): string {
  return `data: ${"y".repeat(lineChars)}\n`.repeat(lines) + "\n";
}

/** Feed a wire through one parser in fixed-size chunks. */
export function replayInChunks(wire: string, chunkChars: number, limits?: SseLimits): ReplayResult {
  const parser = new SseParser(limits);
  const encoder = new TextEncoder();
  const events: SseEvent[] = [];
  let charsFed = 0;
  let error: SseLimitError | null = null;
  try {
    for (let at = 0; at < wire.length; at += chunkChars) {
      const piece = wire.slice(at, at + chunkChars);
      charsFed += piece.length;
      events.push(...parser.feed(encoder.encode(piece)));
    }
    events.push(...parser.end());
  } catch (thrown) {
    if (!(thrown instanceof SseLimitError)) throw thrown;
    error = thrown;
  }
  const stats = parser.stats;
  return {
    events,
    charsFed,
    totalChars: wire.length,
    error,
    droppedLines: stats.droppedLines,
    droppedEvents: stats.droppedEvents,
    retainedCharsHighWater: stats.retainedCharsHighWater,
  };
}
