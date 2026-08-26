/**
 * End-to-end streaming pipeline: byte chunks → SSE events → accumulated
 * assistant text and tool-call arguments, with a partial-JSON snapshot taken
 * after every argument fragment.
 *
 * The interesting outputs are timings and availability: when the first text
 * became visible relative to the whole stream, and how early each tool-call
 * argument field became readable compared to waiting for complete JSON.
 */

import { SseParser, type SseEvent } from "./sse.js";
import { parsePartialJson, type JsonValue, type PartialResult } from "./partialJson.js";
import type { StreamPayload } from "./fixture.js";

export interface FieldAvailability {
  field: string;
  /** Fraction of total stream bytes received when the field first parsed. */
  availableAtByteFraction: number;
}

export interface PipelineResult {
  text: string;
  toolName: string | null;
  toolArgs: JsonValue | null;
  events: SseEvent[];
  /** Partial parse status after every tool_args_delta, in order. */
  argSnapshots: PartialResult[];
  fieldAvailability: FieldAvailability[];
  timeToFirstTextMs: number | null;
  totalMs: number;
  chunkCount: number;
  byteCount: number;
}

export async function runPipeline(
  chunks: AsyncIterable<Uint8Array>,
  totalBytes: number,
): Promise<PipelineResult> {
  const parser = new SseParser();
  const events: SseEvent[] = [];
  const argSnapshots: PartialResult[] = [];
  const firstSeenAtBytes = new Map<string, number>();

  let text = "";
  let toolName: string | null = null;
  let argsText = "";
  let timeToFirstTextMs: number | null = null;
  let chunkCount = 0;
  let byteCount = 0;
  const startedAt = performance.now();

  const handle = (event: SseEvent): void => {
    events.push(event);
    if (event.data === "[DONE]") return;
    const payload = JSON.parse(event.data) as StreamPayload;
    switch (payload.type) {
      case "text_delta":
        if (timeToFirstTextMs === null) {
          timeToFirstTextMs = performance.now() - startedAt;
        }
        text += payload.text ?? "";
        break;
      case "tool_call_start":
        toolName = payload.name ?? null;
        break;
      case "tool_args_delta": {
        argsText += payload.fragment ?? "";
        const snapshot = parsePartialJson(argsText);
        argSnapshots.push(snapshot);
        if (snapshot.status !== "unparseable" && isObject(snapshot.value)) {
          for (const key of Object.keys(snapshot.value)) {
            if (!firstSeenAtBytes.has(key)) firstSeenAtBytes.set(key, byteCount);
          }
        }
        break;
      }
      default:
        break;
    }
  };

  for await (const chunk of chunks) {
    chunkCount++;
    byteCount += chunk.length;
    for (const event of parser.feed(chunk)) handle(event);
  }
  for (const event of parser.end()) handle(event);

  const totalMs = performance.now() - startedAt;
  const finalArgs = argsText === "" ? null : parsePartialJson(argsText);
  const fieldAvailability = [...firstSeenAtBytes.entries()].map(([field, bytes]) => ({
    field,
    availableAtByteFraction: bytes / totalBytes,
  }));

  return {
    text,
    toolName,
    toolArgs: finalArgs !== null && finalArgs.status !== "unparseable" ? finalArgs.value : null,
    events,
    argSnapshots,
    fieldAvailability,
    timeToFirstTextMs,
    totalMs,
    chunkCount,
    byteCount,
  };
}

function isObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
