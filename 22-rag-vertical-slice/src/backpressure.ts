/**
 * Backpressure measured against a deliberately slow sink: every write
 * reports a full buffer and drains one macrotask later, the shape of a
 * client on a bad link. The producer is the same event stream the server
 * sends; the variable is the queue capacity between generation and the
 * writer. Unbounded, the whole answer piles up in memory the moment the
 * client slows down; bounded, the queue's high-water mark is the cap and
 * generation itself is paced. Scheduling is microtask/macrotask ordering,
 * no real clock, so the numbers are exact and repeatable.
 */

import { setImmediate as nextMacrotask } from "node:timers/promises";
import { streamEvents, type StreamSink, type WireEvent } from "./stream.js";

export interface BackpressureRun {
  label: string;
  events: number;
  bytes: number;
  highWaterItems: number;
  highWaterBytes: number;
  stalledPushes: number;
}

function slowSink(): StreamSink {
  return {
    write: () => false,
    waitDrain: async () => {
      await nextMacrotask();
    },
  };
}

export async function runSlowClient(
  label: string,
  events: readonly WireEvent[],
  queueCapacity: number,
): Promise<BackpressureRun> {
  const result = await streamEvents(events.slice(), slowSink(), queueCapacity);
  return {
    label,
    events: result.events,
    bytes: result.bytes,
    highWaterItems: result.queue.highWaterMark,
    highWaterBytes: result.queue.sizeHighWaterMark,
    stalledPushes: result.queue.stalledPushes,
  };
}
