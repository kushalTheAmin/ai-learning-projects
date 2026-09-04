/**
 * Workload and replay harness for pricing the resumable scanner against the
 * full-rescan baseline.
 *
 * The workload is the streaming tool-call shape: one JSON document arrives
 * as fragments, and the consumer wants the best-known value after every
 * fragment. The baseline answers that with `parsePartialJson` over the
 * accumulated text (rescan + reparse, O(n) per fragment); the resumable
 * parser answers with `push` + `view` (O(fragment) per fragment) or
 * `push` + `snapshot` (deep copy, back to O(tree) per fragment).
 *
 * Documents are generated from a seeded PRNG so every size is reproducible,
 * with escapes and non-ascii mixed in so the string fast path and the
 * escape state machine both run.
 */

import { parsePartialJson } from "./partialJson.js";
import { ResumableJsonParser } from "./resumableJson.js";
import { chunkOffsets } from "./chunker.js";
import { createRng, randInt, type Rng } from "./rng.js";

const WORDS = [
  "retrieval",
  "latency",
  "chunk",
  "backpressure",
  "stream",
  "tokens",
  "queue",
  "budget",
  "café",
  "naïve",
  "résumé",
  "solar ☀",
  "thumbs 👍",
  'quoted "term"',
  "line\nbreak",
  "tab\tstop",
  "backslash \\ path",
];

function sentence(rng: Rng, words: number): string {
  const parts: string[] = [];
  for (let i = 0; i < words; i++) {
    parts.push(WORDS[randInt(rng, 0, WORDS.length - 1)] as string);
  }
  return parts.join(" ");
}

/**
 * A tool-call-shaped JSON document of at least `targetChars` characters
 * (JSON text length, not bytes). Deterministic per (targetChars, seed).
 */
export function makeToolCallJson(targetChars: number, seed: number): string {
  const rng = createRng(seed);
  interface Annotation {
    span: number[];
    label: string;
    note: string;
    verified: boolean;
    weight: number;
  }
  const doc = {
    query: sentence(rng, 8),
    top_k: randInt(rng, 1, 50),
    include_snippets: true,
    threshold: randInt(rng, 1, 999) / 1000,
    content: sentence(rng, Math.max(4, Math.floor(targetChars / 20))),
    annotations: [] as Annotation[],
  };
  let length = JSON.stringify(doc).length;
  while (length < targetChars) {
    const start = randInt(rng, 0, 5000);
    const annotation: Annotation = {
      span: [start, start + randInt(rng, 1, 400)],
      label: sentence(rng, 1),
      note: sentence(rng, 3),
      verified: rng() < 0.5,
      weight: randInt(rng, 0, 1000) / 1000,
    };
    doc.annotations.push(annotation);
    length += JSON.stringify(annotation).length + 1;
  }
  return JSON.stringify(doc);
}

/**
 * Characters the rescan baseline feeds its scanner over a whole replay:
 * the sum of the prefix lengths it reparses, one per fragment. Depends only
 * on the fragment boundaries, so it is exact without running the replay —
 * which is the only way to state the cost at sizes where the baseline takes
 * minutes of CPU.
 */
export function baselineScanChars(docChars: number, seed: number, maxFragmentChars: number): number {
  let total = 0;
  for (const boundary of chunkOffsets(docChars, seed, maxFragmentChars)) total += boundary;
  return total;
}

export type ReplayMode = "baseline" | "view" | "snapshot";

export interface ReplayStats {
  ms: number;
  /** Characters fed through a scanner, summed over fragments. */
  charsScanned: number;
  fragments: number;
  /** JSON.stringify of the result after the final fragment, for cross-checking. */
  finalResult: string;
}

/**
 * Feed `json` fragment by fragment (seeded boundaries, 1..maxFragmentChars
 * each) and materialize a result after every fragment.
 */
export function replay(json: string, seed: number, maxFragmentChars: number, mode: ReplayMode): ReplayStats {
  const boundaries = chunkOffsets(json.length, seed, maxFragmentChars);
  const started = performance.now();
  let charsScanned = 0;
  let finalResult = "";

  if (mode === "baseline") {
    let accumulated = "";
    let previous = 0;
    for (const boundary of boundaries) {
      accumulated += json.slice(previous, boundary);
      previous = boundary;
      charsScanned += accumulated.length;
      const result = parsePartialJson(accumulated);
      if (boundary === json.length) finalResult = JSON.stringify(result);
    }
  } else {
    const parser = new ResumableJsonParser();
    let previous = 0;
    for (const boundary of boundaries) {
      parser.push(json.slice(previous, boundary));
      charsScanned += boundary - previous;
      previous = boundary;
      const result = mode === "view" ? parser.view() : parser.snapshot();
      if (boundary === json.length) finalResult = JSON.stringify(result);
    }
  }

  return {
    ms: performance.now() - started,
    charsScanned,
    fragments: boundaries.length,
    finalResult,
  };
}

/** Median wall time over `repeats` replays; the other stats are deterministic. */
export function replayTimed(
  json: string,
  seed: number,
  maxFragmentChars: number,
  mode: ReplayMode,
  repeats: number,
): ReplayStats {
  const runs: ReplayStats[] = [];
  for (let i = 0; i < repeats; i++) {
    runs.push(replay(json, seed, maxFragmentChars, mode));
  }
  const times = runs.map((run) => run.ms).sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)] as number;
  return { ...(runs[0] as ReplayStats), ms: median };
}
