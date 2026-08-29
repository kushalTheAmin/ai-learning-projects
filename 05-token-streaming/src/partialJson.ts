/**
 * Partial-JSON parsing for streamed tool-call arguments.
 *
 * LLM APIs stream function-call arguments as fragments of one JSON document.
 * Waiting for the closing brace means the UI (or a speculative tool dispatch)
 * learns nothing until the very last token. This module parses any prefix of
 * a valid JSON document into the best-known value at that point.
 *
 * Approach: a single left-to-right scan tracks the open-container stack, the
 * in-progress token, and the last "safe" index — a position where the text
 * plus closing brackets parses cleanly. At end of input the in-progress token
 * is finished when that is unambiguous (close the string, complete `tru` to
 * `true`, trim `12.` to `12`), otherwise the dangling piece (a key with no
 * value yet, a lone comma) is dropped back to the safe index. Then the still
 * open containers are closed and the result is parsed.
 *
 * Semantics of a "partial" value: it is a snapshot, not a promise. A string
 * value may still grow, and a number's trailing digits may still change
 * (`12` can become `125`). Keys only appear once their value has started.
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type PartialResult =
  | { status: "complete"; value: JsonValue }
  | { status: "partial"; value: JsonValue }
  | { status: "unparseable" };

type Frame =
  | { kind: "object"; phase: "expectFirstKey" | "expectKey" | "expectColon" | "expectValue" | "afterValue" }
  | { kind: "array"; phase: "expectFirstValue" | "expectValue" | "afterValue" };

type Token =
  | { type: "string"; start: number; isKey: boolean; escapeStart: number }
  | { type: "number"; start: number }
  | { type: "literal"; start: number };

export const NUMBER_CHARS = /[0-9eE+\-.]/;
export const NUMBER_RE = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;
export const LITERALS = ["true", "false", "null"];

export function parsePartialJson(text: string): PartialResult {
  const scan = scanPrefix(text);
  if (scan === null) return { status: "unparseable" };

  const { stack, token, safe, rootDone } = scan;
  if (token === null && stack.length === 0) {
    if (!rootDone) return { status: "unparseable" }; // whitespace only
    return { status: "complete", value: JSON.parse(text) as JsonValue };
  }

  let repaired: string | null = null;
  if (token !== null && inValuePosition(stack, token, rootDone)) {
    const completed = completeToken(text, token);
    if (completed !== null) {
      repaired = text.slice(0, token.start) + completed + closers(stack);
    }
  }
  if (repaired === null) {
    if (safe === 0) return { status: "unparseable" };
    repaired = text.slice(0, safe) + closers(stack);
  }

  try {
    return { status: "partial", value: JSON.parse(repaired) as JsonValue };
  } catch {
    return { status: "unparseable" };
  }
}

interface ScanState {
  stack: Frame[];
  token: Token | null;
  /** Largest index where text[0..safe) + closers parses cleanly. */
  safe: number;
  /** True once a complete top-level value has been read. */
  rootDone: boolean;
}

/** Returns null when the prefix cannot be a prefix of any valid JSON document. */
function scanPrefix(text: string): ScanState | null {
  const stack: Frame[] = [];
  let token: Token | null = null;
  let safe = 0;
  let rootDone = false;

  const completeValue = (end: number): boolean => {
    const top = stack[stack.length - 1];
    if (top === undefined) {
      if (rootDone) return false; // two top-level values
      rootDone = true;
    } else if (top.kind === "object" && top.phase === "expectValue") {
      top.phase = "afterValue";
    } else if (top.kind === "array" && (top.phase === "expectValue" || top.phase === "expectFirstValue")) {
      top.phase = "afterValue";
    } else {
      return false;
    }
    safe = end;
    return true;
  };

  const valueAllowed = (): boolean => {
    const top = stack[stack.length - 1];
    if (top === undefined) return !rootDone;
    if (top.kind === "object") return top.phase === "expectValue";
    return top.phase === "expectFirstValue" || top.phase === "expectValue";
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;

    if (token !== null && token.type === "string") {
      if (token.escapeStart !== -1) {
        // Inside an escape sequence; \uXXXX consumes four hex digits.
        const escLen = i - token.escapeStart;
        if (escLen === 1) {
          if (ch === "u") continue;
          if (!'"\\/bfnrt'.includes(ch)) return null;
          token.escapeStart = -1;
        } else {
          if (!/[0-9a-fA-F]/.test(ch)) return null;
          if (escLen === 5) token.escapeStart = -1;
        }
        continue;
      }
      if (ch === "\\") {
        token.escapeStart = i;
      } else if (ch === '"') {
        if (token.isKey) {
          const top = stack[stack.length - 1];
          if (top === undefined || top.kind !== "object") return null;
          top.phase = "expectColon";
        } else if (!completeValue(i + 1)) {
          return null;
        }
        token = null;
      }
      continue;
    }

    if (token !== null && token.type === "number") {
      if (NUMBER_CHARS.test(ch)) continue;
      if (!NUMBER_RE.test(text.slice(token.start, i))) return null;
      if (!completeValue(i)) return null;
      token = null;
      // fall through to reprocess ch as structure
    }

    if (token !== null && token.type === "literal") {
      if (/[a-z]/.test(ch)) continue;
      const word = text.slice(token.start, i);
      if (!LITERALS.includes(word)) return null;
      if (!completeValue(i)) return null;
      token = null;
      // fall through to reprocess ch as structure
    }

    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") continue;

    const top = stack[stack.length - 1];
    switch (ch) {
      case "{":
        if (!valueAllowed()) return null;
        stack.push({ kind: "object", phase: "expectFirstKey" });
        safe = i + 1;
        break;
      case "[":
        if (!valueAllowed()) return null;
        stack.push({ kind: "array", phase: "expectFirstValue" });
        safe = i + 1;
        break;
      case "}":
        if (top === undefined || top.kind !== "object") return null;
        if (top.phase !== "expectFirstKey" && top.phase !== "afterValue") return null;
        stack.pop();
        if (!completeValue(i + 1)) return null;
        break;
      case "]":
        if (top === undefined || top.kind !== "array") return null;
        if (top.phase !== "expectFirstValue" && top.phase !== "afterValue") return null;
        stack.pop();
        if (!completeValue(i + 1)) return null;
        break;
      case '"': {
        const isKey =
          top !== undefined &&
          top.kind === "object" &&
          (top.phase === "expectFirstKey" || top.phase === "expectKey");
        if (!isKey && !valueAllowed()) return null;
        token = { type: "string", start: i, isKey, escapeStart: -1 };
        break;
      }
      case ",":
        if (top === undefined || top.phase !== "afterValue") return null;
        top.phase = top.kind === "object" ? "expectKey" : "expectValue";
        break;
      case ":":
        if (top === undefined || top.kind !== "object" || top.phase !== "expectColon") return null;
        top.phase = "expectValue";
        break;
      default:
        if (ch === "-" || /[0-9]/.test(ch)) {
          if (!valueAllowed()) return null;
          token = { type: "number", start: i };
        } else if (ch === "t" || ch === "f" || ch === "n") {
          if (!valueAllowed()) return null;
          token = { type: "literal", start: i };
        } else {
          return null;
        }
        break;
    }
  }

  return { stack, token, safe, rootDone };
}

function inValuePosition(stack: Frame[], token: Token, rootDone: boolean): boolean {
  if (token.type === "string" && token.isKey) return false;
  const top = stack[stack.length - 1];
  if (top === undefined) return !rootDone;
  if (top.kind === "object") return top.phase === "expectValue";
  return top.phase === "expectFirstValue" || top.phase === "expectValue";
}

/** Finish an in-progress token at end of input, or null when nothing usable remains. */
function completeToken(text: string, token: Token): string | null {
  if (token.type === "string") {
    const cut = token.escapeStart === -1 ? text.length : token.escapeStart;
    return text.slice(token.start, cut) + '"';
  }
  if (token.type === "literal") {
    const prefix = text.slice(token.start);
    const matches = LITERALS.filter((w) => w.startsWith(prefix));
    return matches.length === 1 && matches[0] !== undefined ? matches[0] : null;
  }
  let candidate = text.slice(token.start);
  while (candidate.length > 0 && !NUMBER_RE.test(candidate)) {
    candidate = candidate.slice(0, -1);
  }
  return candidate.length > 0 ? candidate : null;
}

function closers(stack: Frame[]): string {
  let out = "";
  for (let i = stack.length - 1; i >= 0; i--) {
    out += (stack[i] as Frame).kind === "object" ? "}" : "]";
  }
  return out;
}
