/**
 * Resumable partial-JSON parsing.
 *
 * `parsePartialJson` rescans the accumulated text and reparses the repaired
 * string on every fragment — O(n) per fragment, O(n²) over a stream. This
 * parser carries the scan state between fragments instead: the container
 * stack holds references into the value tree being built, string tokens are
 * decoded as their characters arrive, and number/literal tokens keep their
 * own small text buffer. A `push` therefore costs the fragment, never the
 * stream, and the accumulated text is never needed at all.
 *
 * Two ways to read the current value:
 *
 * - `view()` — O(1) beyond the dangling-token completion. Returns the live
 *   tree; it is valid until the next call on the parser and must not be
 *   mutated or retained across a `push`.
 * - `snapshot()` — a deep copy, safe to hold and mutate, at O(tree) cost.
 *   Taking one per fragment reintroduces the quadratic bill `view` removes.
 *
 * Semantics match `parsePartialJson` for every prefix of a valid JSON
 * document, and the tests pin that equivalence prefix by prefix. Two
 * deliberate divergences on invalid input: this parser never throws (the
 * baseline lets `JSON.parse` throw on a completed string containing a raw
 * control character; here the character just ends up in the string), and
 * once a fragment poisons the document, every later result is
 * `unparseable` without rescanning anything.
 */

import {
  LITERALS,
  NUMBER_CHARS,
  NUMBER_RE,
  type JsonValue,
  type PartialResult,
} from "./partialJson.js";

type ObjectPhase = "expectFirstKey" | "expectKey" | "expectColon" | "expectValue" | "afterValue";
type ArrayPhase = "expectFirstValue" | "expectValue" | "afterValue";

type Frame =
  | { kind: "object"; phase: ObjectPhase; container: { [key: string]: JsonValue }; pendingKey: string | null }
  | { kind: "array"; phase: ArrayPhase; container: JsonValue[] };

type Token =
  /** `esc` holds an in-progress escape sequence (`\`, `\u`, `\u2`, …), empty when outside one. */
  | { type: "string"; isKey: boolean; decoded: string; esc: string }
  | { type: "number"; text: string }
  | { type: "literal"; text: string };

/**
 * Set an object key the way `JSON.parse` does: a plain own data property.
 * `container[key] = value` would instead run the inherited `__proto__`
 * setter for that one key name, silently dropping it from the document and
 * reparenting the object being built.
 */
function setKey(container: { [key: string]: JsonValue }, key: string, value: JsonValue): void {
  Object.defineProperty(container, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

const SIMPLE_ESCAPES: { [ch: string]: string } = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

export class ResumableJsonParser {
  private stack: Frame[] = [];
  private token: Token | null = null;
  private root: JsonValue | undefined = undefined;
  private rootDone = false;
  private poisoned = false;
  /** Reverts a dangling-token value temporarily attached by `view()`. */
  private viewUndo: (() => void) | null = null;

  push(fragment: string): void {
    this.undoView();
    if (this.poisoned) return;

    const n = fragment.length;
    let i = 0;
    while (i < n) {
      const token = this.token;

      if (token !== null && token.type === "string") {
        if (token.esc !== "") {
          const ch = fragment[i] as string;
          if (token.esc === "\\") {
            if (ch === "u") {
              token.esc = "\\u";
            } else {
              const mapped = SIMPLE_ESCAPES[ch];
              if (mapped === undefined) return this.fail();
              token.decoded += mapped;
              token.esc = "";
            }
          } else {
            if (!/[0-9a-fA-F]/.test(ch)) return this.fail();
            token.esc += ch;
            if (token.esc.length === 6) {
              token.decoded += String.fromCharCode(parseInt(token.esc.slice(2), 16));
              token.esc = "";
            }
          }
          i++;
          continue;
        }
        // Plain string content: jump to the next escape or closing quote.
        const quote = fragment.indexOf('"', i);
        const backslash = fragment.indexOf("\\", i);
        const stop =
          quote === -1
            ? backslash === -1
              ? n
              : backslash
            : backslash === -1
              ? quote
              : Math.min(quote, backslash);
        if (stop > i) {
          token.decoded += fragment.slice(i, stop);
          i = stop;
          if (i >= n) break;
        }
        if (fragment[i] === "\\") {
          token.esc = "\\";
          i++;
          continue;
        }
        // Closing quote.
        if (token.isKey) {
          const top = this.stack[this.stack.length - 1];
          if (top === undefined || top.kind !== "object") return this.fail();
          top.phase = "expectColon";
          top.pendingKey = token.decoded;
        } else {
          this.completeScalar(token.decoded);
          if (this.poisoned) return;
        }
        this.token = null;
        i++;
        continue;
      }

      const ch = fragment[i] as string;

      if (token !== null && token.type === "number") {
        if (NUMBER_CHARS.test(ch)) {
          token.text += ch;
          i++;
          continue;
        }
        if (!NUMBER_RE.test(token.text)) return this.fail();
        this.completeScalar(Number(token.text));
        this.token = null;
        if (this.poisoned) return;
        // fall through to reprocess ch as structure
      }

      if (this.token !== null && this.token.type === "literal") {
        const literal = this.token;
        if (/[a-z]/.test(ch)) {
          literal.text += ch;
          i++;
          continue;
        }
        if (!LITERALS.includes(literal.text)) return this.fail();
        this.completeScalar(literal.text === "true" ? true : literal.text === "false" ? false : null);
        this.token = null;
        if (this.poisoned) return;
        // fall through to reprocess ch as structure
      }

      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
        i++;
        continue;
      }

      const top = this.stack[this.stack.length - 1];
      switch (ch) {
        case "{": {
          if (!this.valueAllowed()) return this.fail();
          const container: { [key: string]: JsonValue } = {};
          this.attachValue(container);
          this.stack.push({ kind: "object", phase: "expectFirstKey", container, pendingKey: null });
          break;
        }
        case "[": {
          if (!this.valueAllowed()) return this.fail();
          const container: JsonValue[] = [];
          this.attachValue(container);
          this.stack.push({ kind: "array", phase: "expectFirstValue", container });
          break;
        }
        case "}":
          if (top === undefined || top.kind !== "object") return this.fail();
          if (top.phase !== "expectFirstKey" && top.phase !== "afterValue") return this.fail();
          this.stack.pop();
          this.markValueDone();
          break;
        case "]":
          if (top === undefined || top.kind !== "array") return this.fail();
          if (top.phase !== "expectFirstValue" && top.phase !== "afterValue") return this.fail();
          this.stack.pop();
          this.markValueDone();
          break;
        case '"': {
          const isKey =
            top !== undefined &&
            top.kind === "object" &&
            (top.phase === "expectFirstKey" || top.phase === "expectKey");
          if (!isKey && !this.valueAllowed()) return this.fail();
          this.token = { type: "string", isKey, decoded: "", esc: "" };
          break;
        }
        case ",":
          if (top === undefined || top.phase !== "afterValue") return this.fail();
          top.phase = top.kind === "object" ? "expectKey" : "expectValue";
          break;
        case ":":
          if (top === undefined || top.kind !== "object" || top.phase !== "expectColon") return this.fail();
          top.phase = "expectValue";
          break;
        default:
          if (ch === "-" || /[0-9]/.test(ch)) {
            if (!this.valueAllowed()) return this.fail();
            this.token = { type: "number", text: ch };
          } else if (ch === "t" || ch === "f" || ch === "n") {
            if (!this.valueAllowed()) return this.fail();
            this.token = { type: "literal", text: ch };
          } else {
            return this.fail();
          }
          break;
      }
      if (this.poisoned) return;
      i++;
    }
  }

  /**
   * Best-known value right now, as the live tree. Valid until the next call
   * on this parser; do not mutate it or hold it across a `push`.
   */
  view(): PartialResult {
    this.undoView();
    if (this.poisoned) return { status: "unparseable" };

    const token = this.token;
    if (token === null) {
      if (this.stack.length === 0 && this.rootDone) {
        return { status: "complete", value: this.root as JsonValue };
      }
      if (this.root === undefined) return { status: "unparseable" };
      return { status: "partial", value: this.root };
    }

    if (this.inValuePosition(token)) {
      const completed = this.completeDangling(token);
      if (completed !== null) {
        if (this.stack.length === 0) return { status: "partial", value: completed.value };
        this.attachForView(completed.value);
        return { status: "partial", value: this.root as JsonValue };
      }
    }
    if (this.root === undefined) return { status: "unparseable" };
    return { status: "partial", value: this.root };
  }

  /** Best-known value as an independent deep copy, safe to hold and mutate. */
  snapshot(): PartialResult {
    const result = this.view();
    if (result.status === "unparseable") return result;
    const value = structuredClone(result.value);
    this.undoView();
    return { status: result.status, value };
  }

  private fail(): void {
    this.poisoned = true;
    this.stack = [];
    this.token = null;
    this.root = undefined;
  }

  private valueAllowed(): boolean {
    const top = this.stack[this.stack.length - 1];
    if (top === undefined) return !this.rootDone;
    if (top.kind === "object") return top.phase === "expectValue";
    return top.phase === "expectFirstValue" || top.phase === "expectValue";
  }

  /** Put a value where the scan position says it belongs; no phase change. */
  private attachValue(value: JsonValue): void {
    const top = this.stack[this.stack.length - 1];
    if (top === undefined) {
      this.root = value;
    } else if (top.kind === "object") {
      if (top.pendingKey === null) return this.fail();
      setKey(top.container, top.pendingKey, value);
    } else {
      top.container.push(value);
    }
  }

  /** The phase transition of the baseline's `completeValue`, minus the attach. */
  private markValueDone(): void {
    const top = this.stack[this.stack.length - 1];
    if (top === undefined) {
      if (this.rootDone) return this.fail();
      this.rootDone = true;
    } else if (top.kind === "object" && top.phase === "expectValue") {
      top.phase = "afterValue";
    } else if (top.kind === "array" && (top.phase === "expectValue" || top.phase === "expectFirstValue")) {
      top.phase = "afterValue";
    } else {
      return this.fail();
    }
  }

  private completeScalar(value: JsonValue): void {
    this.attachValue(value);
    if (this.poisoned) return;
    this.markValueDone();
  }

  private inValuePosition(token: Token): boolean {
    if (token.type === "string" && token.isKey) return false;
    const top = this.stack[this.stack.length - 1];
    if (top === undefined) return !this.rootDone;
    if (top.kind === "object") return top.phase === "expectValue";
    return top.phase === "expectFirstValue" || top.phase === "expectValue";
  }

  /** Finish the in-progress token when unambiguous; the baseline's `completeToken`. */
  private completeDangling(token: Token): { value: JsonValue } | null {
    if (token.type === "string") return { value: token.decoded };
    if (token.type === "literal") {
      const matches = LITERALS.filter((word) => word.startsWith(token.text));
      if (matches.length !== 1) return null;
      const word = matches[0] as string;
      return { value: word === "true" ? true : word === "false" ? false : null };
    }
    let candidate = token.text;
    while (candidate.length > 0 && !NUMBER_RE.test(candidate)) {
      candidate = candidate.slice(0, -1);
    }
    return candidate.length > 0 ? { value: Number(candidate) } : null;
  }

  /** Attach a completed dangling value into the live tree, recording the revert. */
  private attachForView(value: JsonValue): void {
    const top = this.stack[this.stack.length - 1] as Frame;
    if (top.kind === "array") {
      const container = top.container;
      container.push(value);
      this.viewUndo = () => {
        container.pop();
      };
    } else {
      const container = top.container;
      const key = top.pendingKey as string;
      const had = Object.prototype.hasOwnProperty.call(container, key);
      const previous = container[key];
      setKey(container, key, value);
      this.viewUndo = () => {
        if (had) {
          setKey(container, key, previous as JsonValue);
        } else {
          delete container[key];
        }
      };
    }
  }

  private undoView(): void {
    if (this.viewUndo !== null) {
      this.viewUndo();
      this.viewUndo = null;
    }
  }
}
