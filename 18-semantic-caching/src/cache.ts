/**
 * Semantic response cache. Two lookup layers: an exact map on the
 * normalized query text (free, and can never serve a different query's
 * answer than the same normalized text would get), then nearest-neighbor
 * cosine over every stored entry, serving when similarity reaches the
 * threshold — and, under an optional margin policy, only when the best
 * entry beats its runner-up by a required gap. No eviction: the store only
 * grows, which is fine at replay scale and wrong in production (open
 * thread).
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

/**
 * Serve-margin rule: a semantic serve must beat its runner-up by at least
 * `margin` cosine, or the cache refuses and lets the request go to the
 * model. Scope picks who counts as a runner-up: "all" is every other
 * stored entry (the literal rule); "differing-answer" only entries whose
 * stored answer text differs from the best entry's, so phrasings of the
 * same intent never block each other. Both are computable by a real cache
 * — answers are stored, intents are not — but "differing-answer" leans on
 * one intent producing one answer text, which a live model would not
 * guarantee across phrasings.
 */
export interface MarginPolicy {
  margin: number;
  scope: "all" | "differing-answer";
}

export type CacheDecision =
  | { kind: "miss" }
  | { kind: "exact"; entry: CacheEntry }
  | {
      kind: "semantic";
      entry: CacheEntry;
      similarity: number;
      /** Best similarity among the other entries; undefined on a 1-entry store. */
      competitorAll: number | undefined;
      /** Best similarity among entries with a different answer; undefined if none stored. */
      competitorDiffering: number | undefined;
    }
  | { kind: "margin-refused"; entry: CacheEntry; similarity: number; competitor: number };

export class SemanticCache {
  private readonly byKey = new Map<string, CacheEntry>();
  private readonly entries: CacheEntry[] = [];

  constructor(
    private readonly featurizer: Featurizer,
    private readonly threshold: number,
    private readonly marginPolicy?: MarginPolicy,
  ) {}

  get size(): number {
    return this.entries.length;
  }

  /**
   * Decide what the cache would serve for this query. Exact layer first;
   * otherwise the single most similar entry, served iff its cosine reaches
   * the threshold and, under a margin policy, beats its in-scope runner-up
   * by the margin. Ties keep the earliest-inserted entry so replays are
   * order-deterministic. A serve with no in-scope runner-up passes any
   * margin: there is nothing to confuse it with yet, which is exactly when
   * a margin rule is blind.
   */
  lookup(query: string): CacheDecision {
    const key = normalizeText(query);
    const exact = this.byKey.get(key);
    if (exact !== undefined) return { kind: "exact", entry: exact };

    const vector = this.featurizer.embed(query);
    let best: CacheEntry | undefined;
    let bestSimilarity = -1;
    let runnerUp = -1;
    const bestByAnswer = new Map<string, number>();
    for (const entry of this.entries) {
      const similarity = cosine(vector, entry.vector);
      const perAnswer = bestByAnswer.get(entry.answer);
      if (perAnswer === undefined || similarity > perAnswer) {
        bestByAnswer.set(entry.answer, similarity);
      }
      if (similarity > bestSimilarity) {
        runnerUp = bestSimilarity;
        bestSimilarity = similarity;
        best = entry;
      } else if (similarity > runnerUp) {
        runnerUp = similarity;
      }
    }
    if (best === undefined || bestSimilarity < this.threshold) return { kind: "miss" };

    let differing = -1;
    for (const [answer, similarity] of bestByAnswer) {
      if (answer !== best.answer && similarity > differing) differing = similarity;
    }
    const competitorAll = this.entries.length > 1 ? runnerUp : undefined;
    const competitorDiffering = differing >= 0 ? differing : undefined;

    const policy = this.marginPolicy;
    if (policy !== undefined && policy.margin > 0) {
      const competitor = policy.scope === "all" ? competitorAll : competitorDiffering;
      if (competitor !== undefined && bestSimilarity - competitor < policy.margin) {
        return { kind: "margin-refused", entry: best, similarity: bestSimilarity, competitor };
      }
    }
    return { kind: "semantic", entry: best, similarity: bestSimilarity, competitorAll, competitorDiffering };
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
