/**
 * Span-based redaction: replace each detected span with a typed placeholder
 * like [EMAIL_1]. The same literal value always maps to the same placeholder
 * within one call, so "reply to [EMAIL_1] or [EMAIL_1]" survives readably.
 */

import type { PiiSpan } from "./pii.js";

export interface RedactionResult {
  redacted: string;
  /** placeholder -> original value, in first-appearance order */
  placeholders: Map<string, string>;
  spansReplaced: number;
}

export function redact(text: string, spans: PiiSpan[]): RedactionResult {
  const ordered = [...spans].sort((a, b) => a.start - b.start);
  const placeholders = new Map<string, string>();
  const byValue = new Map<string, string>();
  const counters = new Map<string, number>();
  let out = "";
  let cursor = 0;
  let spansReplaced = 0;
  for (const span of ordered) {
    if (span.start < cursor) continue; // overlapping input, keep the earlier one
    let placeholder = byValue.get(`${span.type} ${span.value}`);
    if (placeholder === undefined) {
      const n = (counters.get(span.type) ?? 0) + 1;
      counters.set(span.type, n);
      placeholder = `[${span.type}_${n}]`;
      byValue.set(`${span.type} ${span.value}`, placeholder);
      placeholders.set(placeholder, span.value);
    }
    out += text.slice(cursor, span.start) + placeholder;
    cursor = span.end;
    spansReplaced++;
  }
  out += text.slice(cursor);
  return { redacted: out, placeholders, spansReplaced };
}
