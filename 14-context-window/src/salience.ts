/**
 * Two definitions of "which sentence matters", used by the summarize policy.
 *
 * Luhn (1958): a sentence matters if it contains a dense cluster of
 * significant words, where significant means FREQUENT in the text after
 * stopwords are dropped. Built for articles, where the topic words repeat.
 *
 * Rarity (idf-style): a sentence matters if its content words are RARE
 * across the text's sentences, scored as mean inverse sentence-frequency.
 * A decision stated once is made of rare tokens; chatter repeats.
 *
 * The two rank in nearly opposite order on conversation transcripts, and
 * measuring that gap is most of the point of this project.
 *
 * Everything is deterministic: counting, scoring, and selection order
 * (score descending, original position ascending on ties).
 */

import { estimateTokens } from "../../08-agent-tool-loop/src/messages.js";
import { STOPWORDS, words } from "./text.js";

export interface ScoredSentence {
  index: number;
  text: string;
  score: number;
}

export type SentenceScorer = (sents: readonly string[]) => ScoredSentence[];

export interface LuhnOptions {
  /** A word must appear at least this many times to be significant. */
  minFrequency: number;
  /** Max insignificant words allowed between two significant ones inside a cluster. */
  maxGap: number;
}

export const DEFAULT_LUHN: LuhnOptions = { minFrequency: 2, maxGap: 4 };

function contentWords(sentence: string): string[] {
  return words(sentence).filter((w) => !STOPWORDS.has(w));
}

/** Words that clear the frequency bar across all sentences, stopwords excluded. */
export function significantWords(sents: readonly string[], opts: LuhnOptions = DEFAULT_LUHN): Set<string> {
  const freq = new Map<string, number>();
  for (const s of sents) {
    for (const w of contentWords(s)) {
      freq.set(w, (freq.get(w) ?? 0) + 1);
    }
  }
  const out = new Set<string>();
  for (const [w, n] of freq) if (n >= opts.minFrequency) out.add(w);
  return out;
}

/**
 * Luhn's cluster score for one sentence: find maximal runs of words where
 * significant words are never separated by more than maxGap insignificant
 * ones, and score each run as significantCount^2 / runLength. The sentence
 * scores its best run; a sentence with no significant word scores 0.
 */
export function luhnScoreSentence(sentence: string, significant: ReadonlySet<string>, opts: LuhnOptions = DEFAULT_LUHN): number {
  const ws = words(sentence);
  let best = 0;
  let runStart = -1;
  let runEnd = -1;
  let runCount = 0;
  const closeRun = () => {
    if (runCount > 0) {
      const span = runEnd - runStart + 1;
      const score = (runCount * runCount) / span;
      if (score > best) best = score;
    }
    runStart = -1;
    runEnd = -1;
    runCount = 0;
  };
  for (let i = 0; i < ws.length; i++) {
    if (significant.has(ws[i] as string)) {
      if (runStart === -1) runStart = i;
      else if (i - runEnd > opts.maxGap + 1) {
        closeRun();
        runStart = i;
      }
      runEnd = i;
      runCount++;
    }
  }
  closeRun();
  return best;
}

export function luhnScorer(opts: LuhnOptions = DEFAULT_LUHN): SentenceScorer {
  return (sents) => {
    const significant = significantWords(sents, opts);
    return sents.map((text, index) => ({ index, text, score: luhnScoreSentence(text, significant, opts) }));
  };
}

/**
 * Rarity score: mean over the sentence's unique content words of
 * ln(N / sf(w)), where sf(w) is the number of sentences containing w and N
 * the total sentence count. A sentence of once-seen words scores ln(N);
 * a sentence of words every sentence repeats scores 0; no content words
 * scores 0. The mean (not the sum) keeps long chatty sentences from
 * winning on word count alone.
 */
export function rarityScorer(): SentenceScorer {
  return (sents) => {
    const n = sents.length;
    const sentenceFreq = new Map<string, number>();
    const uniquePerSentence: string[][] = sents.map((s) => [...new Set(contentWords(s))]);
    for (const unique of uniquePerSentence) {
      for (const w of unique) sentenceFreq.set(w, (sentenceFreq.get(w) ?? 0) + 1);
    }
    return sents.map((text, index) => {
      const unique = uniquePerSentence[index] as string[];
      if (unique.length === 0) return { index, text, score: 0 };
      let sum = 0;
      for (const w of unique) sum += Math.log(n / (sentenceFreq.get(w) as number));
      return { index, text, score: sum / unique.length };
    });
  };
}

/**
 * Pick the highest-scoring sentences that fit in tokenBudget, then emit them
 * in original order. Zero-scoring sentences are never picked. A sentence that
 * does not fit is skipped and the scan continues, so the budget gets packed
 * rather than cut off at the first oversized sentence.
 */
export function summarize(sents: readonly string[], tokenBudget: number, scorer: SentenceScorer): string[] {
  const ranked = scorer(sents)
    .filter((s) => s.score > 0)
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.index - b.index));
  const picked: ScoredSentence[] = [];
  let used = 0;
  for (const s of ranked) {
    const cost = estimateTokens(s.text);
    if (used + cost > tokenBudget) continue;
    picked.push(s);
    used += cost;
  }
  picked.sort((a, b) => a.index - b.index);
  return picked.map((s) => s.text);
}
