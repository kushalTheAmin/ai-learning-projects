/**
 * Semantic response cache. Two lookup layers: an exact map on the
 * normalized query text (free, and can never serve a different query's
 * answer than the same normalized text would get), then nearest-neighbor
 * cosine over every stored entry, serving when similarity reaches the
 * threshold. No eviction: the store only grows, which is fine at replay
 * scale and wrong in production (open thread).
 */

import { cosine, normalizeText, type Featurizer, type SparseVector } from "./features.js";

export interface CacheEntry {
  /** Normalized text of the query that created the entry. */
  key: string;
  vector: SparseVector;
  answer: string;
  /**
   * Ground-truth intent of the creating query. Carried for the evaluator
   * only — lookup never reads it, a real cache would not have it.
   */
  intentId: string;
}

export type CacheDecision =
  | { kind: "miss" }
  | { kind: "exact"; entry: CacheEntry }
  | { kind: "semantic"; entry: CacheEntry; similarity: number };

export class SemanticCache {
  private readonly byKey = new Map<string, CacheEntry>();
  private readonly entries: CacheEntry[] = [];

  constructor(
    private readonly featurizer: Featurizer,
    private readonly threshold: number,
  ) {}

  get size(): number {
    return this.entries.length;
  }

  /**
   * Decide what the cache would serve for this query. Exact layer first;
   * otherwise the single most similar entry, served iff its cosine reaches
   * the threshold. Ties keep the earliest-inserted entry so replays are
   * order-deterministic.
   */
  lookup(query: string): CacheDecision {
    const key = normalizeText(query);
    const exact = this.byKey.get(key);
    if (exact !== undefined) return { kind: "exact", entry: exact };

    const vector = this.featurizer.embed(query);
    let best: CacheEntry | undefined;
    let bestSimilarity = -1;
    for (const entry of this.entries) {
      const similarity = cosine(vector, entry.vector);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        best = entry;
      }
    }
    if (best !== undefined && bestSimilarity >= this.threshold) {
      return { kind: "semantic", entry: best, similarity: bestSimilarity };
    }
    return { kind: "miss" };
  }

  /** Store the answer a miss fetched. One entry per normalized key. */
  insert(query: string, answer: string, intentId: string): void {
    const key = normalizeText(query);
    if (this.byKey.has(key)) return;
    const entry: CacheEntry = { key, vector: this.featurizer.embed(query), answer, intentId };
    this.byKey.set(key, entry);
    this.entries.push(entry);
  }
}
