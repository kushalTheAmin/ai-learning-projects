/**
 * Rule-based PII span detection over raw text. Each detector emits exact
 * [start, end) character spans; overlapping candidates are resolved by
 * start position, then span length, then a fixed type priority.
 *
 * Deliberate scope choices, measured rather than hidden:
 * - phones must be formatted (separators or a +country prefix); a bare
 *   10-digit run is not claimed, so unformatted phones are misses
 * - card candidates must pass a brand-prefix check and (by default) Luhn
 * - SSNs must be dash-formatted with a valid area/group/serial
 * - secrets are known key prefixes plus a charset-agnostic entropy gate
 */

import { entropyBitsPerChar, luhnValid } from "./checks.js";

export type PiiType = "EMAIL" | "PHONE" | "SSN" | "CARD" | "IP" | "SECRET";

export interface PiiSpan {
  start: number;
  end: number;
  type: PiiType;
  value: string;
}

export interface DetectOptions {
  /** verify card candidates with the Luhn checksum (default true) */
  luhn?: boolean;
  /** entropy gate for prefix-less secrets, bits per char (default 4.0) */
  entropyThreshold?: number;
}

export const DEFAULT_ENTROPY_THRESHOLD = 4.0;

/** lower index wins when two spans overlap and tie on start and length */
const TYPE_PRIORITY: readonly PiiType[] = [
  "CARD",
  "SECRET",
  "SSN",
  "PHONE",
  "IP",
  "EMAIL",
];

function priorityOf(type: PiiType): number {
  return TYPE_PRIORITY.indexOf(type);
}

function charAt(text: string, index: number): string {
  return index >= 0 && index < text.length ? text.charAt(index) : "";
}

function digitCount(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 48 && c <= 57) n++;
  }
  return n;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

function detectEmails(text: string): PiiSpan[] {
  const spans: PiiSpan[] = [];
  for (const m of text.matchAll(EMAIL_RE)) {
    spans.push({ start: m.index, end: m.index + m[0].length, type: "EMAIL", value: m[0] });
  }
  return spans;
}

/** +country followed by 8-15 digits with optional spaces, dots, dashes, parens */
const PHONE_INTL_RE = /\+\d[\d .()-]{6,18}\d/g;
/** NANP shape with mandatory separators: (415) 555-0134, 415-555-0199, 415.555.0134 */
const PHONE_US_RE = /\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}/g;

function detectPhones(text: string): PiiSpan[] {
  const spans: PiiSpan[] = [];
  for (const m of text.matchAll(PHONE_INTL_RE)) {
    const value = m[0];
    const digits = digitCount(value);
    if (digits < 8 || digits > 15) continue;
    if (/\d/.test(charAt(text, m.index - 1)) || /\d/.test(charAt(text, m.index + value.length))) continue;
    spans.push({ start: m.index, end: m.index + value.length, type: "PHONE", value });
  }
  for (const m of text.matchAll(PHONE_US_RE)) {
    const value = m[0];
    // reject only when a digit or plus abuts the match: that means it is a
    // slice of a longer number, not that a sentence period follows it
    if (/[\d+]/.test(charAt(text, m.index - 1)) || /\d/.test(charAt(text, m.index + value.length))) continue;
    spans.push({ start: m.index, end: m.index + value.length, type: "PHONE", value });
  }
  return spans;
}

const SSN_RE = /\d{3}-\d{2}-\d{4}/g;

function ssnFieldsValid(value: string): boolean {
  const area = Number(value.slice(0, 3));
  const group = Number(value.slice(4, 6));
  const serial = Number(value.slice(7, 11));
  if (area === 0 || area === 666 || area >= 900) return false;
  if (group === 0) return false;
  if (serial === 0) return false;
  return true;
}

function detectSsns(text: string): PiiSpan[] {
  const spans: PiiSpan[] = [];
  for (const m of text.matchAll(SSN_RE)) {
    const value = m[0];
    const before = charAt(text, m.index - 1);
    const after = charAt(text, m.index + value.length);
    if (/[\d-]/.test(before) || /[\d-]/.test(after)) continue;
    if (!ssnFieldsValid(value)) continue;
    spans.push({ start: m.index, end: m.index + value.length, type: "SSN", value });
  }
  return spans;
}

/** 13-19 digits, single spaces or dashes allowed between them */
const CARD_CANDIDATE_RE = /\d(?:[ -]?\d){11,18}/g;

function cardPrefixKnown(digits: string): boolean {
  if (digits.startsWith("4")) return true; // visa
  const two = Number(digits.slice(0, 2));
  if (two >= 51 && two <= 55) return true; // mastercard
  if (two === 34 || two === 37) return true; // amex
  if (digits.startsWith("6011") || digits.startsWith("65")) return true; // discover
  return false;
}

function detectCards(text: string, useLuhn: boolean): PiiSpan[] {
  const spans: PiiSpan[] = [];
  for (const m of text.matchAll(CARD_CANDIDATE_RE)) {
    const value = m[0];
    const digits = value.replace(/[ -]/g, "");
    if (digits.length < 13 || digits.length > 19) continue;
    const before = charAt(text, m.index - 1);
    const after = charAt(text, m.index + value.length);
    if (/[\d-]/.test(before) || /[\d-]/.test(after)) continue;
    if (!cardPrefixKnown(digits)) continue;
    if (useLuhn && !luhnValid(digits)) continue;
    spans.push({ start: m.index, end: m.index + value.length, type: "CARD", value });
  }
  return spans;
}

const IP_RE = /(?:\d{1,3}\.){3}\d{1,3}/g;

function detectIps(text: string): PiiSpan[] {
  const spans: PiiSpan[] = [];
  for (const m of text.matchAll(IP_RE)) {
    const value = m[0];
    const before = charAt(text, m.index - 1);
    const afterAt = m.index + value.length;
    const after = charAt(text, afterAt);
    // a leading word char or dot means this is a slice of a longer token; a
    // trailing digit, or a dot followed by a digit, means a truncated octet
    if (/[\w.]/.test(before)) continue;
    if (/\d/.test(after) || (after === "." && /\d/.test(charAt(text, afterAt + 1)))) continue;
    const octets = value.split(".").map(Number);
    if (octets.some((o) => o > 255)) continue;
    spans.push({ start: m.index, end: m.index + value.length, type: "IP", value });
  }
  return spans;
}

const SECRET_PREFIX_RE =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[abp]-[A-Za-z0-9-]{10,})\b/g;

/** 20+ chars of key-ish alphabet, needs at least one letter and one digit */
const SECRET_CANDIDATE_RE = /[A-Za-z0-9_\-+/=]{20,}/g;

function detectSecrets(text: string, entropyThreshold: number): PiiSpan[] {
  const spans: PiiSpan[] = [];
  for (const m of text.matchAll(SECRET_PREFIX_RE)) {
    spans.push({ start: m.index, end: m.index + m[0].length, type: "SECRET", value: m[0] });
  }
  for (const m of text.matchAll(SECRET_CANDIDATE_RE)) {
    const value = m[0];
    if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) continue;
    if (spans.some((s) => m.index < s.end && s.start < m.index + value.length)) continue;
    if (entropyBitsPerChar(value) < entropyThreshold) continue;
    spans.push({ start: m.index, end: m.index + value.length, type: "SECRET", value });
  }
  return spans;
}

/** greedy non-overlap resolution: earliest start, then longest, then type priority */
export function resolveOverlaps(spans: PiiSpan[]): PiiSpan[] {
  const sorted = [...spans].sort(
    (a, b) =>
      a.start - b.start ||
      b.end - b.start - (a.end - a.start) ||
      priorityOf(a.type) - priorityOf(b.type),
  );
  const kept: PiiSpan[] = [];
  for (const span of sorted) {
    const last = kept[kept.length - 1];
    if (last !== undefined && span.start < last.end) continue;
    kept.push(span);
  }
  return kept;
}

export function detectPii(text: string, opts: DetectOptions = {}): PiiSpan[] {
  const useLuhn = opts.luhn ?? true;
  const entropyThreshold = opts.entropyThreshold ?? DEFAULT_ENTROPY_THRESHOLD;
  const all = [
    ...detectCards(text, useLuhn),
    ...detectSecrets(text, entropyThreshold),
    ...detectSsns(text),
    ...detectPhones(text),
    ...detectIps(text),
    ...detectEmails(text),
  ];
  return resolveOverlaps(all);
}
