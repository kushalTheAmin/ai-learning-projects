/**
 * Loaders for the two authored datasets.
 *
 * PII corpus items carry gold spans inline with ⟦TYPE⟧...⟦/⟧ markers; the
 * loader strips the markers and records exact [start, end) offsets into the
 * clean text, so gold offsets can never drift from the text they annotate.
 *
 * The prompt set drives the injection and pipeline measurements. Attack
 * items carry a scripted-model outcome (does the model comply, and does the
 * leak carry the system prompt verbatim or paraphrased); benign items may
 * carry PII markers so output redaction can be checked against gold values.
 */

import { readFileSync } from "node:fs";
import type { PiiSpan, PiiType } from "./pii.js";

const PII_TYPES: readonly PiiType[] = ["EMAIL", "PHONE", "SSN", "CARD", "IP", "SECRET"];

const OPEN = "⟦";
const CLOSE_MARKER = "⟦/⟧";

export interface PiiItem {
  id: string;
  text: string;
  spans: PiiSpan[];
  note?: string;
}

export interface ParsedMarkedText {
  text: string;
  spans: PiiSpan[];
}

export function parseMarkedText(marked: string): ParsedMarkedText {
  let text = "";
  let i = 0;
  const spans: PiiSpan[] = [];
  while (i < marked.length) {
    const openAt = marked.indexOf(OPEN, i);
    if (openAt === -1) {
      text += marked.slice(i);
      break;
    }
    if (marked.startsWith(CLOSE_MARKER, openAt)) {
      throw new Error(`unmatched close marker at index ${openAt}`);
    }
    text += marked.slice(i, openAt);
    const typeEnd = marked.indexOf("⟧", openAt);
    if (typeEnd === -1) throw new Error(`unterminated type marker at index ${openAt}`);
    const type = marked.slice(openAt + OPEN.length, typeEnd);
    if (!(PII_TYPES as readonly string[]).includes(type)) {
      throw new Error(`unknown pii type "${type}" at index ${openAt}`);
    }
    const closeAt = marked.indexOf(CLOSE_MARKER, typeEnd);
    if (closeAt === -1) throw new Error(`marker ⟦${type}⟧ never closed`);
    const value = marked.slice(typeEnd + 1, closeAt);
    if (value.length === 0) throw new Error(`empty ⟦${type}⟧ span`);
    if (value.includes(OPEN)) throw new Error(`nested marker inside ⟦${type}⟧`);
    spans.push({ start: text.length, end: text.length + value.length, type: type as PiiType, value });
    text += value;
    i = closeAt + CLOSE_MARKER.length;
  }
  return { text, spans };
}

interface RawPiiItem {
  id: string;
  marked: string;
  note?: string;
}

export function loadPiiCorpus(path: string): PiiItem[] {
  const raw = JSON.parse(readFileSync(path, "utf8")) as RawPiiItem[];
  const seen = new Set<string>();
  return raw.map((item) => {
    if (seen.has(item.id)) throw new Error(`duplicate pii item id ${item.id}`);
    seen.add(item.id);
    const parsed = parseMarkedText(item.marked);
    return { id: item.id, text: parsed.text, spans: parsed.spans, note: item.note };
  });
}

export type LeakStyle = "verbatim" | "paraphrase" | "none";

export type AttackCategory =
  | "plain-override"
  | "exfiltration"
  | "roleplay"
  | "smuggling"
  | "spacing"
  | "leet"
  | "homoglyph"
  | "base64";

export interface PromptItem {
  id: string;
  kind: "attack" | "benign";
  category: AttackCategory | "benign" | "benign-trap";
  text: string;
  /** gold PII spans inside the prompt text (benign items with markers) */
  piiSpans: PiiSpan[];
  /** attack items only: what the scripted model does if the prompt reaches it */
  model?: { complies: boolean; leak: LeakStyle };
}

interface RawPromptItem {
  id: string;
  kind: "attack" | "benign";
  category: PromptItem["category"];
  marked: string;
  model?: { complies: boolean; leak: LeakStyle };
}

export function loadPrompts(path: string): PromptItem[] {
  const raw = JSON.parse(readFileSync(path, "utf8")) as RawPromptItem[];
  const seen = new Set<string>();
  return raw.map((item) => {
    if (seen.has(item.id)) throw new Error(`duplicate prompt id ${item.id}`);
    seen.add(item.id);
    if (item.kind === "attack" && item.model === undefined) {
      throw new Error(`attack ${item.id} has no scripted model outcome`);
    }
    if (item.kind === "benign" && item.model !== undefined) {
      throw new Error(`benign ${item.id} must not script a model outcome`);
    }
    if (item.model !== undefined && !item.model.complies && item.model.leak !== "none") {
      throw new Error(`attack ${item.id} leaks without complying`);
    }
    const parsed = parseMarkedText(item.marked);
    return {
      id: item.id,
      kind: item.kind,
      category: item.category,
      text: parsed.text,
      piiSpans: parsed.spans,
      model: item.model,
    };
  });
}
