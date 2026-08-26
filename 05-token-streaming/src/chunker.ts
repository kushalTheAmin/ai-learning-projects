/**
 * Byte-level chunker simulating how a network hands you a stream: in chunks
 * of arbitrary size that ignore character, line, and event boundaries.
 */

import { createRng, randInt } from "./rng.js";

export interface ChunkOptions {
  seed: number;
  /** Chunk sizes are uniform in [1, maxChunkBytes]. */
  maxChunkBytes: number;
  /** Await this many ms between chunks; 0 yields to the event loop only. */
  delayMs: number;
}

export async function* chunkBytes(
  bytes: Uint8Array,
  { seed, maxChunkBytes, delayMs }: ChunkOptions,
): AsyncGenerator<Uint8Array, void, void> {
  const rng = createRng(seed);
  let offset = 0;
  while (offset < bytes.length) {
    const size = randInt(rng, 1, maxChunkBytes);
    yield bytes.subarray(offset, offset + size);
    offset += size;
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    } else {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
}

/** Deterministic list of chunk boundaries for a seed (used by fuzz tests). */
export function chunkOffsets(totalBytes: number, seed: number, maxChunkBytes: number): number[] {
  const rng = createRng(seed);
  const offsets: number[] = [];
  let offset = 0;
  while (offset < totalBytes) {
    offset += randInt(rng, 1, maxChunkBytes);
    offsets.push(Math.min(offset, totalBytes));
  }
  return offsets;
}
