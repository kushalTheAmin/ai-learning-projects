/**
 * Scripted LLM stream: builds the exact SSE bytes a streaming completion
 * would put on the wire, then slices them into network chunks at arbitrary
 * (seeded, reproducible) byte boundaries — including boundaries that fall
 * inside a multi-byte UTF-8 code point.
 *
 * Everything here is authored, not sampled from a model. The point is that
 * the parsers on the other end must not be able to tell the difference:
 * correctness is judged by reassembling the same message from every chunking.
 */

export interface Script {
  text: string;
  toolName: string;
  args: unknown;
}

/** The response every experiment streams. Unicode is load-bearing: the
 *  emoji, CJK, and accents force multi-byte UTF-8 sequences that random
 *  chunk boundaries will split. */
export const FLIGHT_SCRIPT: Script = {
  text:
    "Let me search for flights matching that. Zürich to São Paulo is a long " +
    "haul — I'll allow one stop. 検索中… ✈️ Running the search now.",
  toolName: "search_flights",
  args: {
    origin: "ZRH",
    destination: "GRU",
    date: "2026-09-14",
    passengers: 2,
    cabin: "economy",
    filters: {
      maxStops: 1,
      maxPriceUsd: 1450.5,
      refundable: false,
      airlines: ["LX", "LH", "TP"],
    },
    note: "traveler prefers aisle 💺; arrival before 10:00 se possível",
  },
};

/** Deterministic PRNG (mulberry32) so every chunking is reproducible. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sseEvent(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** Split text into word-sized pieces, spaces attached to the word before
 *  them being emitted — roughly how token-by-token text deltas look. */
export function splitTextDeltas(text: string): string[] {
  const pieces = text.match(/\S+\s*|\s+/gu);
  return pieces ?? [];
}

/** Split a JSON string into delta pieces of seeded random length 1..maxPiece,
 *  mimicking input_json_delta events, which ignore token boundaries. */
export function splitJsonDeltas(json: string, seed: number, maxPiece: number): string[] {
  const rng = seededRandom(seed);
  const pieces: string[] = [];
  let at = 0;
  while (at < json.length) {
    const size = 1 + Math.floor(rng() * maxPiece);
    pieces.push(json.slice(at, at + size));
    at += size;
  }
  return pieces;
}

/** Build the full SSE byte stream for a scripted response. */
export function buildSseBytes(script: Script, seed = 41): Uint8Array {
  let out = "";
  out += sseEvent("message_start", { message: { role: "assistant" } });

  out += sseEvent("content_block_start", {
    index: 0,
    content_block: { type: "text" },
  });
  for (const piece of splitTextDeltas(script.text)) {
    out += sseEvent("content_block_delta", {
      index: 0,
      delta: { type: "text_delta", text: piece },
    });
  }
  out += sseEvent("content_block_stop", { index: 0 });

  out += sseEvent("content_block_start", {
    index: 1,
    content_block: { type: "tool_use", name: script.toolName },
  });
  const argsJson = JSON.stringify(script.args);
  for (const piece of splitJsonDeltas(argsJson, seed, 8)) {
    out += sseEvent("content_block_delta", {
      index: 1,
      delta: { type: "input_json_delta", partial_json: piece },
    });
  }
  out += sseEvent("content_block_stop", { index: 1 });

  out += sseEvent("message_stop", {});
  return new TextEncoder().encode(out);
}

/** Slice bytes into chunks of seeded random size 1..maxChunk. Boundaries are
 *  byte positions, so they freely land inside UTF-8 sequences. */
export function chunkRandomly(bytes: Uint8Array, seed: number, maxChunk: number): Uint8Array[] {
  const rng = seededRandom(seed);
  const chunks: Uint8Array[] = [];
  let at = 0;
  while (at < bytes.length) {
    const size = 1 + Math.floor(rng() * maxChunk);
    chunks.push(bytes.subarray(at, at + size));
    at += size;
  }
  return chunks;
}

/** Slice bytes into fixed-size chunks. */
export function chunkFixed(bytes: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += size) {
    chunks.push(bytes.subarray(at, at + size));
  }
  return chunks;
}
