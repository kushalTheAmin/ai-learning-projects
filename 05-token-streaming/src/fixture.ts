/**
 * Scripted LLM turn used by the demo and the tests.
 *
 * This stands in for a real streaming API: the event shapes mirror how LLM
 * providers stream a reply (text deltas, then tool-call arguments as raw JSON
 * fragments inside event payloads), but every byte here is authored. Numbers
 * measured over it exercise the parsing and flow-control code, not any model.
 *
 * The text and the tool arguments deliberately contain multi-byte UTF-8
 * (Devanagari, emoji) so byte-level chunking can split characters, and the
 * arguments contain nesting, escapes, and unicode so partial parsing is
 * exercised on more than flat ASCII.
 */

import type { JsonValue } from "./partialJson.js";

export const ASSISTANT_TEXT =
  "Checking the release notes for you. " +
  "काठमाडौंको समयअनुसार भोलि बिहान — that is tomorrow morning ☀️ — " +
  "I will look for anything tagged “breaking change” and summarise it.";

export const TOOL_NAME = "search_release_notes";

export const TOOL_ARGS: { [key: string]: JsonValue } = {
  query: "breaking change deploy pipeline “v2 API”",
  top_k: 5,
  filters: { source: "official", after: "2026-01-01", tags: ["breaking", "deploy"] },
  include_snippets: true,
  note: "काठमाडौं ☀️ newline\nand a \"quoted\" bit",
};

export interface StreamPayload {
  type: string;
  text?: string;
  name?: string;
  fragment?: string;
}

/** Split a string into pieces of the given sizes cycling through `sizes`. */
function splitBySizes(s: string, sizes: number[]): string[] {
  const out: string[] = [];
  let i = 0;
  let k = 0;
  while (i < s.length) {
    const size = sizes[k % sizes.length] as number;
    out.push(s.slice(i, i + size));
    i += size;
    k++;
  }
  return out;
}

/** The scripted turn as a list of SSE events, before serialization. */
export function scriptedEvents(): { event: string; payload: StreamPayload }[] {
  const events: { event: string; payload: StreamPayload }[] = [
    { event: "message_start", payload: { type: "message_start" } },
  ];
  // Text arrives in small word-ish deltas, the way providers actually send it.
  for (const piece of splitBySizes(ASSISTANT_TEXT, [7, 3, 11, 5, 2, 9])) {
    events.push({ event: "text_delta", payload: { type: "text_delta", text: piece } });
  }
  events.push({
    event: "tool_call_start",
    payload: { type: "tool_call_start", name: TOOL_NAME },
  });
  const argsJson = JSON.stringify(TOOL_ARGS);
  for (const piece of splitBySizes(argsJson, [4, 9, 2, 6, 13, 3])) {
    events.push({
      event: "tool_args_delta",
      payload: { type: "tool_args_delta", fragment: piece },
    });
  }
  events.push({ event: "message_stop", payload: { type: "message_stop" } });
  return events;
}

/** Serialize the scripted turn to SSE wire bytes, ending with `data: [DONE]`. */
export function scriptedSseBytes(): Uint8Array {
  let wire = "";
  let id = 0;
  for (const { event, payload } of scriptedEvents()) {
    wire += `event: ${event}\nid: ${id++}\ndata: ${JSON.stringify(payload)}\n\n`;
  }
  wire += "data: [DONE]\n\n";
  return new TextEncoder().encode(wire);
}
