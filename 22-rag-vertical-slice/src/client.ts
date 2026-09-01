/**
 * Streaming client for the endpoint, and the consumer half of the wire
 * contract: it reads the response body chunk by chunk, feeds the raw bytes
 * to 05's incremental SSE parser, and reassembles the answer from token
 * events. It also records the byte position at which the first token
 * event completed — the streaming payoff in a deterministic unit (bytes,
 * not wall time): the fraction of the response a client must receive
 * before it can show something. That position is computed by re-encoding
 * each parsed event with the server's own serializer, so it is exact wire
 * bytes and independent of how TCP happened to slice the chunks; the
 * chunk-summed byte count is kept alongside and the two must agree.
 */

import { SseParser, type SseEvent } from "../../05-token-streaming/src/sse.js";
import { serializeEvent } from "./stream.js";
import type { Usage } from "./server.js";

export interface RetrievedRef {
  docId: string;
  score: number;
}

export interface AskMeta {
  requestId: string;
  k: number;
  retrieved: RetrievedRef[];
}

export interface AskResult {
  status: number;
  /** Error message from a non-200 response body. */
  error?: string;
  meta?: AskMeta;
  answer: string;
  tokenEvents: number;
  outcome?: "answered" | "refused";
  /** The best sentence's overlap score the server made the refusal call on. */
  bestOverlap?: number;
  usage?: Usage;
  /** Bytes received off the socket, summed over network chunks. */
  totalBytes: number;
  /** The same total re-encoded from parsed events; must equal totalBytes. */
  wireBytes: number;
  /** Wire bytes up to and including the first token event; undefined if none. */
  bytesAtFirstToken?: number;
}

export async function ask(baseUrl: string, body: unknown): Promise<AskResult> {
  const response = await fetch(`${baseUrl}/ask`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (response.status !== 200) {
    const payload = (await response.json()) as { error?: string };
    return { status: response.status, error: payload.error, answer: "", tokenEvents: 0, totalBytes: 0, wireBytes: 0 };
  }

  const result: AskResult = { status: 200, answer: "", tokenEvents: 0, totalBytes: 0, wireBytes: 0 };
  const parser = new SseParser();
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();

  const handle = (event: SseEvent): void => {
    result.wireBytes += serializeEvent({ event: event.event, data: event.data }).length;
    if (event.event === "meta") {
      result.meta = JSON.parse(event.data) as AskMeta;
    } else if (event.event === "token") {
      const token = JSON.parse(event.data) as { text: string };
      result.answer += token.text;
      result.tokenEvents++;
      if (result.bytesAtFirstToken === undefined) result.bytesAtFirstToken = result.wireBytes;
    } else if (event.event === "done") {
      const done = JSON.parse(event.data) as { outcome: "answered" | "refused"; bestOverlap: number; usage: Usage };
      result.outcome = done.outcome;
      result.bestOverlap = done.bestOverlap;
      result.usage = done.usage;
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    result.totalBytes += value.length;
    for (const event of parser.feed(value)) handle(event);
  }
  for (const event of parser.end()) handle(event);
  return result;
}
