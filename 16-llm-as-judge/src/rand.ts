/**
 * Seed derivation and gaussian sampling on top of 05's mulberry32.
 * Every judge call derives its own rng stream from a string identity, so
 * a call is deterministic given (judge, item, presentation order) and two
 * calls with different identities draw independent noise.
 */

import { createRng, type Rng } from "../../05-token-streaming/src/rng.js";

/** FNV-1a 32-bit hash over a string, used as an rng seed. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Rng stream for one named call site. */
export function streamFor(identity: string): Rng {
  return createRng(fnv1a(identity));
}

/** Standard normal via Box-Muller. Uses 1-u so the log argument stays in (0, 1]. */
export function gaussian(rng: Rng): number {
  const u1 = 1 - rng();
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Uniform draw in [lo, hi). */
export function uniform(rng: Rng, lo: number, hi: number): number {
  return lo + rng() * (hi - lo);
}
