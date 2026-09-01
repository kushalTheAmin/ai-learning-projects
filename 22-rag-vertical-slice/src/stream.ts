/**
 * Server side of SSE: event serialization to wire bytes, a drain-aware
 * sink writer, and the streaming pipeline that puts 05's bounded
 * AsyncQueue between the model (producer) and the socket (consumer).
 *
 * Two backpressure layers, one per boundary. The queue paces the model
 * against the writer: a bounded queue means a slow client caps how far
 * generation runs ahead of delivery, and the queue's own high-water stats
 * are the evidence. The drain protocol paces the writer against the
 * socket: when write() returns false the writer stops until the sink
 * drains, instead of piling bytes into the kernel-side buffer's shadow
 * copy in user space.
 */

import { AsyncQueue, type QueueStats } from "../../05-token-streaming/src/queue.js";

/**
 * Capacity of the queue between generation and the socket, in either
 * currency: a number caps buffered events, the object form can also cap
 * buffered wire bytes (05's byte-budget queue). Under a byte budget the
 * bound is max(maxBytes, largest single event): an event bigger than the
 * whole budget is admitted alone rather than deadlocking the stream, and
 * the queue counts those admissions in `oversizedPushes`.
 */
export type QueueLimit = number | { maxItems?: number; maxBytes?: number };

export interface WireEvent {
  /** Omitted on the wire when undefined; the parser defaults to "message". */
  event?: string;
  data: string;
}

const ENCODER = new TextEncoder();

/**
 * One event in wire form. Multi-line data becomes one `data:` line per
 * line, which the receiving parser rejoins with "\n" — the round trip is
 * exact for any payload without a bare CR (JSON.stringify output never
 * carries one).
 */
export function serializeEvent(event: WireEvent): Uint8Array {
  let wire = "";
  if (event.event !== undefined) wire += `event: ${event.event}\n`;
  for (const line of event.data.split("\n")) wire += `data: ${line}\n`;
  wire += "\n";
  return ENCODER.encode(wire);
}

/** The slice of a writable stream the writer needs; node's res satisfies it. */
export interface StreamSink {
  /** false means the sink's buffer is full and the caller should wait. */
  write(chunk: Uint8Array): boolean;
  /** Resolves when a full sink can accept writes again. */
  waitDrain(): Promise<void>;
}

/** Write one event, honoring the sink's backpressure signal. */
export async function writeEvent(sink: StreamSink, event: WireEvent): Promise<number> {
  const bytes = serializeEvent(event);
  if (!sink.write(bytes)) await sink.waitDrain();
  return bytes.length;
}

export interface StreamResult {
  events: number;
  bytes: number;
  queue: QueueStats;
}

/**
 * Pump events through a bounded queue into the sink. The producer loop
 * awaits every push, so once the queue is full the source iterator is not
 * advanced again until the writer frees a slot — generation is paced by
 * delivery, not just buffered ahead of it.
 */
export async function streamEvents(
  source: AsyncIterable<WireEvent> | Iterable<WireEvent>,
  sink: StreamSink,
  queueLimit: QueueLimit,
): Promise<StreamResult> {
  const wireBytes = (event: WireEvent): number => serializeEvent(event).length;
  const queue =
    typeof queueLimit === "number"
      ? new AsyncQueue<WireEvent>(queueLimit, wireBytes)
      : new AsyncQueue<WireEvent>({ ...queueLimit, sizeOf: wireBytes });
  const producer = (async () => {
    for await (const event of source) await queue.push(event);
    queue.close();
  })();
  let events = 0;
  let bytes = 0;
  for await (const event of queue) {
    bytes += await writeEvent(sink, event);
    events++;
  }
  await producer;
  return { events, bytes, queue: queue.stats };
}
