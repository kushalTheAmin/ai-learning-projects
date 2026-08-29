/**
 * Scripted extractive model. This is the simulated component of the slice:
 * no network call, no weights. Given the question and the retrieved docs it
 * splits the context into sentences (14's splitter), scores each sentence
 * by the fraction of the question's content words it contains (14's
 * tokenizer and stopword list), and streams the best sentence verbatim as
 * word-sized pieces — or a fixed refusal when nothing in the context
 * clears the overlap floor. Deterministic by construction: same question
 * and same context, same answer, every time.
 *
 * The consequence for the eval: the endpoint answers correctly iff
 * retrieval brought the gold doc in AND the gold sentence out-scores every
 * other sentence in the context. Both failure modes are real and the
 * harness attributes misses between them.
 */

import { sentences, words, STOPWORDS } from "../../14-context-window/src/text.js";
import type { Doc } from "./data.js";

export const SYSTEM_PROMPT =
  "answer using only the provided context. quote the sentence that answers the question. " +
  "if the context does not contain the answer, say you cannot answer.";

export const REFUSAL = "i cannot answer that from the retrieved context.";

/** Minimum fraction of the question's content words a sentence must hold. */
export const MIN_OVERLAP = 0.35;

export interface SentenceScore {
  sentence: string;
  overlap: number;
}

export function contentWords(text: string): Set<string> {
  return new Set(words(text).filter((word) => !STOPWORDS.has(word)));
}

/**
 * Fraction of the question's content words present in the sentence.
 * A question with no content words at all overlaps nothing (0), so it
 * refuses rather than matching every sentence vacuously.
 */
export function overlapScore(questionContent: ReadonlySet<string>, sentence: string): number {
  if (questionContent.size === 0) return 0;
  const sentenceWords = new Set(words(sentence));
  let hits = 0;
  for (const word of questionContent) if (sentenceWords.has(word)) hits++;
  return hits / questionContent.size;
}

/** Best-scoring context sentence; earlier sentence wins ties. */
export function bestSentence(question: string, context: readonly Doc[]): SentenceScore | undefined {
  const questionContent = contentWords(question);
  let best: SentenceScore | undefined;
  for (const doc of context) {
    for (const sentence of sentences(doc.text)) {
      const overlap = overlapScore(questionContent, sentence);
      if (best === undefined || overlap > best.overlap) best = { sentence, overlap };
    }
  }
  return best;
}

/** The full answer text the stream will carry, decided before streaming. */
export function answerText(question: string, context: readonly Doc[]): string {
  const best = bestSentence(question, context);
  if (best === undefined || best.overlap < MIN_OVERLAP) return REFUSAL;
  return best.sentence;
}

/**
 * The answer as word-sized stream pieces (each piece keeps its trailing
 * whitespace, so concatenating the pieces reproduces the answer exactly).
 * Word pieces, not bpe tokens: 08's ~4-chars-per-token estimator prices
 * the text, this split only decides the streaming granularity.
 */
export function answerPieces(answer: string): string[] {
  return answer.match(/\S+\s*/g) ?? [];
}
