/**
 * Small validation primitives the PII detectors sit on: the Luhn checksum
 * that separates card numbers from arbitrary 16-digit runs, and empirical
 * Shannon entropy, which separates random-looking credentials from prose.
 */

/** Luhn checksum over a string of ASCII digits. Non-digit input is invalid. */
export function luhnValid(digits: string): boolean {
  if (!/^\d{2,}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Empirical Shannon entropy in bits per character, computed over the
 * character frequencies of the string itself. Bounded above by both
 * log2(alphabet size) and log2(string length), so short strings can never
 * score as high as long random ones.
 */
export function entropyBitsPerChar(s: string): number {
  const chars = [...s];
  if (chars.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of chars) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  const n = chars.length;
  let h = 0;
  for (const c of counts.values()) {
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}
