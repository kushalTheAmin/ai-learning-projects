/**
 * De-obfuscation normalization for injection matching. The rules in
 * injection.ts are plain lowercase regexes; this pass folds the cheap
 * evasions back into the form those rules expect:
 *
 * - NFKC (fullwidth and compatibility forms fold to ASCII)
 * - zero-width characters stripped
 * - a small homoglyph map (common Cyrillic/Greek lookalikes -> Latin)
 * - leetspeak digits mapped to letters, but only inside tokens that also
 *   contain letters, so "ticket 50" stays "ticket 50" while "1gn0re" folds
 * - letter-spacing collapsed: runs of 4+ single characters separated by
 *   single spaces, dots or dashes become one word ("i g n o r e" -> "ignore")
 */

const ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF]/g;

export const HOMOGLYPHS: ReadonlyMap<string, string> = new Map([
  ["а", "a"], // cyrillic а
  ["е", "e"], // cyrillic е
  ["о", "o"], // cyrillic о
  ["р", "p"], // cyrillic р
  ["с", "c"], // cyrillic с
  ["у", "y"], // cyrillic у
  ["х", "x"], // cyrillic х
  ["і", "i"], // cyrillic і
  ["ѕ", "s"], // cyrillic ѕ
  ["ο", "o"], // greek omicron
  ["α", "a"], // greek alpha
]);

const LEET: ReadonlyMap<string, string> = new Map([
  ["0", "o"],
  ["1", "i"],
  ["3", "e"],
  ["4", "a"],
  ["5", "s"],
  ["7", "t"],
  ["@", "a"],
  ["$", "s"],
]);

function foldHomoglyphs(text: string): string {
  let out = "";
  for (const ch of text) out += HOMOGLYPHS.get(ch) ?? ch;
  return out;
}

function foldLeetInWordTokens(text: string): string {
  return text.replace(/\S+/g, (token) => {
    if (!/[a-z]/i.test(token)) return token;
    let out = "";
    for (const ch of token) out += LEET.get(ch) ?? ch;
    return out;
  });
}

const SPACED_LETTERS_RE = /(?<![\w.-])(?:[a-z0-9][ .·_-]){3,}[a-z0-9](?![\w.-])/g;

function collapseSpacedLetters(text: string): string {
  return text.replace(SPACED_LETTERS_RE, (run) => run.replace(/[ .·_-]/g, ""));
}

export function normalizeForMatching(text: string): string {
  let out = text.normalize("NFKC");
  out = out.replace(ZERO_WIDTH_RE, "");
  out = out.toLowerCase();
  out = foldHomoglyphs(out);
  out = foldLeetInWordTokens(out);
  out = collapseSpacedLetters(out);
  return out;
}
