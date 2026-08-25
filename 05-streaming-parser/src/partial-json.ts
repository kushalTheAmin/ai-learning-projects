/**
 * Best-effort parser for a prefix of a JSON document.
 *
 * Streamed tool-call arguments arrive as a growing JSON prefix. Waiting for
 * the closing brace means nothing is readable until the very last token; this
 * parser instead returns the largest value the prefix already commits to.
 *
 * Truncation policy, applied at the exact point the input runs out:
 * - inside a string            -> keep the characters decoded so far
 * - dangling escape or \uXXXX  -> drop the incomplete escape, keep the rest
 * - after a key, before value  -> drop the pair ({"a":  -> {})
 * - inside a number            -> trim a dangling ".", "e", sign; keep digits
 *   (the value may still grow — "12" could become "123" — so it is usable
 *   but never marks the document complete)
 * - inside true/false/null     -> drop the literal (it commits to nothing)
 * - inside an object/array     -> close it with the members parsed so far
 *
 * Input that could never extend to valid JSON (e.g. `{a:1}` or `]`) throws
 * PartialJsonError — truncation is tolerated, corruption is not.
 */

export interface PartialParseResult {
  /** Best-effort value. `undefined` when the prefix commits to nothing yet. */
  value: unknown;
  /** True only when the input is one complete JSON document. */
  complete: boolean;
}

export class PartialJsonError extends Error {
  constructor(
    message: string,
    readonly index: number,
  ) {
    super(`${message} at index ${index}`);
    this.name = "PartialJsonError";
  }
}

const MAX_DEPTH = 500;

const NOTHING = Symbol("nothing");

interface Parsed {
  /** NOTHING when the prefix commits to no value here. */
  value: unknown | typeof NOTHING;
  complete: boolean;
}

export function parsePartialJson(text: string): PartialParseResult {
  const parser = new Parser(text);
  const parsed = parser.parseValue(0);
  if (parsed.complete) {
    parser.skipWhitespace();
    if (!parser.atEnd()) parser.fail("unexpected trailing content");
  }
  if (parsed.value === NOTHING) return { value: undefined, complete: false };
  return { value: parsed.value, complete: parsed.complete };
}

class Parser {
  private i = 0;

  constructor(private readonly text: string) {}

  atEnd(): boolean {
    return this.i >= this.text.length;
  }

  skipWhitespace(): void {
    while (!this.atEnd()) {
      const c = this.text[this.i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") this.i++;
      else break;
    }
  }

  fail(message: string): never {
    throw new PartialJsonError(message, this.i);
  }

  parseValue(depth: number): Parsed {
    if (depth > MAX_DEPTH) this.fail(`nesting exceeds max depth ${MAX_DEPTH}`);
    this.skipWhitespace();
    if (this.atEnd()) return { value: NOTHING, complete: false };
    const c = this.text[this.i];
    if (c === "{") return this.parseObject(depth);
    if (c === "[") return this.parseArray(depth);
    if (c === '"') return this.parseString();
    if (c === "t") return this.parseLiteral("true", true);
    if (c === "f") return this.parseLiteral("false", false);
    if (c === "n") return this.parseLiteral("null", null);
    if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) {
      return this.parseNumber();
    }
    this.fail(`unexpected character ${JSON.stringify(c)}`);
  }

  private parseObject(depth: number): Parsed {
    const obj: Record<string, unknown> = {};
    const partial = (): Parsed => ({ value: obj, complete: false });
    this.i++; // consume "{"

    this.skipWhitespace();
    if (this.atEnd()) return partial();
    if (this.text[this.i] === "}") {
      this.i++;
      return { value: obj, complete: true };
    }

    for (;;) {
      // Key. The prefix grammar guarantees a string or nothing here.
      this.skipWhitespace();
      if (this.atEnd()) return partial();
      if (this.text[this.i] !== '"') this.fail("expected string key");
      const key = this.parseString();
      if (!key.complete) return partial();

      this.skipWhitespace();
      if (this.atEnd()) return partial();
      if (this.text[this.i] !== ":") this.fail("expected ':' after key");
      this.i++;

      const value = this.parseValue(depth + 1);
      if (value.value !== NOTHING) obj[key.value as string] = value.value;
      if (!value.complete) return partial();

      this.skipWhitespace();
      if (this.atEnd()) return partial();
      const next = this.text[this.i];
      if (next === "}") {
        this.i++;
        return { value: obj, complete: true };
      }
      if (next !== ",") this.fail("expected ',' or '}' in object");
      this.i++;
    }
  }

  private parseArray(depth: number): Parsed {
    const arr: unknown[] = [];
    const partial = (): Parsed => ({ value: arr, complete: false });
    this.i++; // consume "["

    this.skipWhitespace();
    if (this.atEnd()) return partial();
    if (this.text[this.i] === "]") {
      this.i++;
      return { value: arr, complete: true };
    }

    for (;;) {
      const element = this.parseValue(depth + 1);
      if (element.value !== NOTHING) arr.push(element.value);
      if (!element.complete) return partial();

      this.skipWhitespace();
      if (this.atEnd()) return partial();
      const next = this.text[this.i];
      if (next === "]") {
        this.i++;
        return { value: arr, complete: true };
      }
      if (next !== ",") this.fail("expected ',' or ']' in array");
      this.i++;
    }
  }

  private parseString(): Parsed & { value: string } {
    this.i++; // consume opening quote
    let out = "";
    for (;;) {
      if (this.atEnd()) return { value: out, complete: false };
      const c = this.text[this.i];
      if (c === '"') {
        this.i++;
        return { value: out, complete: true };
      }
      if (c === "\\") {
        const escaped = this.parseEscape();
        if (escaped === undefined) return { value: out, complete: false };
        out += escaped;
        continue;
      }
      if (c !== undefined && c < " ") {
        this.fail("unescaped control character in string");
      }
      out += c;
      this.i++;
    }
  }

  /** Returns the decoded escape, or undefined when the input ends inside it. */
  private parseEscape(): string | undefined {
    if (this.i + 1 >= this.text.length) {
      this.i = this.text.length;
      return undefined;
    }
    const e = this.text[this.i + 1];
    const simple: Record<string, string> = {
      '"': '"',
      "\\": "\\",
      "/": "/",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
    };
    if (e !== undefined && e in simple) {
      this.i += 2;
      return simple[e];
    }
    if (e === "u") {
      const hex = this.text.slice(this.i + 2, this.i + 6);
      if (hex.length < 4) {
        this.i = this.text.length;
        return undefined;
      }
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail("invalid unicode escape");
      this.i += 6;
      // Surrogate halves concatenate into real pairs naturally in JS strings.
      return String.fromCharCode(parseInt(hex, 16));
    }
    this.i++;
    this.fail("invalid escape sequence");
  }

  private parseLiteral(word: string, value: boolean | null): Parsed {
    const run = this.text.slice(this.i, this.i + word.length);
    if (run === word) {
      this.i += word.length;
      return { value, complete: true };
    }
    if (this.i + run.length >= this.text.length && word.startsWith(run)) {
      this.i = this.text.length;
      return { value: NOTHING, complete: false };
    }
    this.fail(`invalid literal starting ${JSON.stringify(run)}`);
  }

  private static readonly NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

  /** Strings some longer input could extend into a valid number — "12.",
   *  "1e-", "-" — as opposed to ones nothing can rescue, like "01". */
  private static readonly NUMBER_PREFIX =
    /^-?(?:0|[1-9]\d*)(?:\.\d*)?(?:[eE][+-]?\d*)?$|^-$/;

  private parseNumber(): Parsed {
    let end = this.i;
    while (end < this.text.length) {
      const c = this.text[end];
      if (c === undefined || !/[0-9eE+\-.]/.test(c)) break;
      end++;
    }
    let run = this.text.slice(this.i, end);
    const truncated = end >= this.text.length;

    if (truncated) {
      if (!Parser.NUMBER_PREFIX.test(run)) this.fail(`invalid number ${JSON.stringify(run)}`);
      // Trim a dangling ".", "e", "e-" — pieces a longer stream would finish.
      while (run.length > 0 && !Parser.NUMBER.test(run)) run = run.slice(0, -1);
      this.i = this.text.length;
      if (run.length === 0) return { value: NOTHING, complete: false };
      // "12" might still become "123": usable, but never complete.
      return { value: Number(run), complete: false };
    }

    if (!Parser.NUMBER.test(run)) this.fail(`invalid number ${JSON.stringify(run)}`);
    this.i = end;
    return { value: Number(run), complete: true };
  }
}
