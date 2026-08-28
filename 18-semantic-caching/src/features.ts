/**
 * Lexical feature embeddings for query similarity: hashed sparse vectors,
 * l2-normalized, compared by cosine. Two featurizers with different failure
 * modes — word unigrams+bigrams, and character trigrams. Both are real
 * computations over the text; nothing here calls a model.
 */

import { fnv1a } from "../../16-llm-as-judge/src/rand.js";

/** Sparse vector: hashed feature id -> weight. Always l2-normalized. */
export type SparseVector = Map<number, number>;

const HASH_DIMS = 1 << 20;

/**
 * Canonical text form shared by the exact-match cache key and the
 * featurizers: lowercase, letters/digits only, single spaces. Two queries
 * with the same normalized form are the same query as far as caching goes.
 */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/ +/g, " ");
}

function tokens(text: string): string[] {
  const normalized = normalizeText(text);
  return normalized.length === 0 ? [] : normalized.split(" ");
}

function l2Normalize(counts: Map<number, number>): SparseVector {
  let sumSquares = 0;
  for (const weight of counts.values()) sumSquares += weight * weight;
  if (sumSquares === 0) return counts;
  const norm = Math.sqrt(sumSquares);
  for (const [id, weight] of counts) counts.set(id, weight / norm);
  return counts;
}

function addFeature(counts: Map<number, number>, feature: string): void {
  const id = fnv1a(feature) % HASH_DIMS;
  counts.set(id, (counts.get(id) ?? 0) + 1);
}

/** Word unigrams and bigrams, hashed and l2-normalized. */
export function wordVector(text: string): SparseVector {
  const words = tokens(text);
  const counts = new Map<number, number>();
  for (const word of words) addFeature(counts, `w:${word}`);
  for (let i = 0; i + 1 < words.length; i++) {
    addFeature(counts, `b:${words[i]} ${words[i + 1]}`);
  }
  return l2Normalize(counts);
}

/**
 * Character trigrams over the normalized text with boundary markers, so
 * word edges count as context. Catches typos and shared morphology that
 * word features miss — and is even blinder to a one-word meaning change.
 */
export function charVector(text: string): SparseVector {
  const normalized = normalizeText(text);
  const counts = new Map<number, number>();
  if (normalized.length > 0) {
    const padded = ` ${normalized} `;
    for (let i = 0; i + 3 <= padded.length; i++) {
      addFeature(counts, `c:${padded.slice(i, i + 3)}`);
    }
  }
  return l2Normalize(counts);
}

export type Featurizer = { name: string; embed: (text: string) => SparseVector };

export const FEATURIZERS: readonly Featurizer[] = [
  { name: "word", embed: wordVector },
  { name: "char", embed: charVector },
];

/** Cosine similarity of two l2-normalized sparse vectors: their dot product. */
export function cosine(a: SparseVector, b: SparseVector): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [id, weight] of small) {
    const other = large.get(id);
    if (other !== undefined) dot += weight * other;
  }
  return dot;
}
