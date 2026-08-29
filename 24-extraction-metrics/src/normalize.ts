/**
 * Value comparison ladder. Each level adds one class of surface variation the
 * comparator forgives; everything it does not forgive stays a wrong value.
 *
 *   L0 exact      strict === on type and value
 *   L1 text       + unicode NFKC, casefold, whitespace collapse on strings
 *   L2 numeric    + "1,234.50", "$1,234.50", "42" match 1234.5 / 42 within a tolerance
 *   L3 date       + "Jan 5, 2024" and "5 January 2024" match "2024-01-05"
 */

import type { JsonPrimitive } from "./json.js";

export interface CompareOptions {
  /** NFKC + lowercase + trim + collapse internal whitespace before comparing strings. */
  textFold: boolean;
  /** Parse number-shaped strings (currency symbol, thousands separators) and compare numerically. */
  numeric: boolean;
  /** Absolute tolerance for numeric comparison. Only used when `numeric` is on. */
  numericTolerance: number;
  /** Parse the supported date formats to ISO and compare the ISO forms. */
  date: boolean;
}

export const LADDER: { name: string; options: CompareOptions }[] = [
  { name: "L0 exact", options: { textFold: false, numeric: false, numericTolerance: 0, date: false } },
  { name: "L1 text", options: { textFold: true, numeric: false, numericTolerance: 0, date: false } },
  { name: "L2 numeric", options: { textFold: true, numeric: true, numericTolerance: 1e-9, date: false } },
  { name: "L3 date", options: { textFold: true, numeric: true, numericTolerance: 1e-9, date: true } },
];

export const STRICT = LADDER[0]!.options;
export const FULL = LADDER[3]!.options;

export function foldText(s: string): string {
  return s.normalize("NFKC").toLowerCase().trim().replace(/\s+/gu, " ");
}

const NUMBER_RE = /^[$€£¥]?\s?-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/u;

/**
 * Parse a number or a number-shaped string. Returns null for anything else,
 * including "", "42abc", booleans, and null.
 */
export function parseNumeric(v: JsonPrimitive): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!NUMBER_RE.test(s)) return null;
  return Number.parseFloat(s.replace(/^[$€£¥]\s?/u, "").replace(/,/g, ""));
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isoDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > (DAYS_IN_MONTH[month - 1] as number)) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Parse the unambiguous date formats to ISO: "2024-01-05", "Jan 5, 2024",
 * "5 January 2024". Slash dates are refused on purpose: 05/01/2024 means a
 * different day on each side of the atlantic, and a metric should not guess.
 */
export function parseDate(v: JsonPrimitive): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m) {
    const month = MONTHS[(m[1] as string).toLowerCase()];
    return month === undefined ? null : isoDate(Number(m[3]), month, Number(m[2]));
  }
  m = /^(\d{1,2})\s+([A-Za-z]+)\.?,?\s+(\d{4})$/.exec(s);
  if (m) {
    const month = MONTHS[(m[2] as string).toLowerCase()];
    return month === undefined ? null : isoDate(Number(m[3]), month, Number(m[1]));
  }
  return null;
}

/**
 * Compare two primitive leaf values under the given options.
 * Layer order: numeric first (so "42" vs 42 never falls into string folding),
 * then date, then text. A comparison only uses a layer when BOTH sides parse
 * under it; otherwise it falls through to the next.
 */
export function valuesMatch(gold: JsonPrimitive, pred: JsonPrimitive, opts: CompareOptions): boolean {
  if (gold === pred) return true;
  if (opts.numeric) {
    const gn = parseNumeric(gold);
    const pn = parseNumeric(pred);
    if (gn !== null && pn !== null) return Math.abs(gn - pn) <= opts.numericTolerance;
    if (gn !== null || pn !== null) {
      // One side is a number and the other is not number-shaped: never a match,
      // and never a candidate for date or text folding either.
      if (typeof gold === "number" || typeof pred === "number") return false;
    }
  }
  if (opts.date) {
    const gd = parseDate(gold);
    const pd = parseDate(pred);
    if (gd !== null && pd !== null) return gd === pd;
  }
  if (opts.textFold && typeof gold === "string" && typeof pred === "string") {
    return foldText(gold) === foldText(pred);
  }
  return false;
}
