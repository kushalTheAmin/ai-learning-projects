/**
 * Doc-level retrieval over 18's hashed lexical embeddings: each doc is one
 * word-feature vector (unigrams + bigrams, hashed, l2-normalized), a query
 * scores against every doc by sparse cosine, top k win. No idf and no
 * stemmer, so this is deliberately the cheapest retrieval that can work on
 * a 10-doc corpus — the point of the slice is what sits around it, and the
 * eval hook prices exactly how far this retriever carries it.
 */

import { cosine, wordVector, type SparseVector } from "../../18-semantic-caching/src/features.js";
import type { Doc } from "./data.js";

export interface Retrieved {
  doc: Doc;
  score: number;
}

interface IndexedDoc {
  doc: Doc;
  vector: SparseVector;
}

export class DocIndex {
  private readonly entries: IndexedDoc[];

  constructor(docs: readonly Doc[]) {
    this.entries = docs.map((doc) => ({
      doc,
      vector: wordVector(`${doc.title}\n${doc.text}`),
    }));
  }

  get size(): number {
    return this.entries.length;
  }

  /**
   * Top k docs by cosine, ties broken by doc id so a ranking is one exact
   * answer. A query with no known words scores 0 everywhere and still
   * returns k docs in id order — the caller decides whether an all-zero
   * ranking is worth passing to a model.
   */
  topK(question: string, k: number): Retrieved[] {
    if (!Number.isInteger(k) || k < 1) throw new RangeError("k must be a positive integer");
    const queryVector = wordVector(question);
    const scored = this.entries.map(({ doc, vector }) => ({ doc, score: cosine(queryVector, vector) }));
    scored.sort((a, b) => b.score - a.score || (a.doc.id < b.doc.id ? -1 : 1));
    return scored.slice(0, k);
  }
}
