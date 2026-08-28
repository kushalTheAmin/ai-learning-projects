/**
 * Word and sentence segmentation shared by the summarizer and the metrics.
 *
 * The word regex is unicode-aware (\p{L}\p{N}, not [a-z0-9]) so a non-ascii
 * letter is part of a word rather than a boundary, and hyphen/underscore
 * compounds like "eu-west-2" stay one token.
 */

const WORD_RE = /[\p{L}\p{N}]+(?:[-_][\p{L}\p{N}]+)*/gu;

export function words(text: string): string[] {
  return text.toLowerCase().match(WORD_RE) ?? [];
}

/** Function words that never count as significant for sentence scoring. */
export const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "and", "or", "but", "so", "if", "then", "than",
  "of", "in", "on", "at", "to", "for", "with", "from", "by", "as",
  "is", "are", "was", "were", "be", "been", "being", "am",
  "it", "its", "this", "that", "these", "those", "there", "here",
  "i", "you", "we", "they", "he", "she", "me", "us", "them", "my",
  "your", "our", "their", "his", "her", "him",
  "do", "does", "did", "done", "doing", "have", "has", "had",
  "can", "could", "should", "would", "will", "shall", "may", "might",
  "not", "no", "yes", "just", "also", "very", "really", "still",
  "what", "which", "who", "when", "where", "why", "how",
  "up", "down", "out", "over", "under", "about", "into", "onto",
  "some", "any", "all", "each", "more", "most", "other", "same",
  "one", "two", "now", "get", "got", "let", "lets", "ok", "okay",
  "please", "thanks", "sure", "well", "right", "back", "again",
]);

/**
 * Split text into sentences on runs of terminators followed by whitespace.
 * Keeps the terminator with its sentence. Text with no terminator at all is
 * one sentence. Deliberately simpler than 10's python splitter: the corpus
 * here is generated, so there are no abbreviations to guard against.
 */
export function sentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "." || text[i] === "!" || text[i] === "?") {
      while (i + 1 < text.length && (text[i + 1] === "." || text[i + 1] === "!" || text[i + 1] === "?")) i++;
      if (i + 1 >= text.length || /\s/.test(text[i + 1] as string)) {
        const piece = text.slice(start, i + 1).trim();
        if (piece.length > 0) out.push(piece);
        start = i + 1;
      }
    }
  }
  const tail = text.slice(start).trim();
  if (tail.length > 0) out.push(tail);
  return out;
}
