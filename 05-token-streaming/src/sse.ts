/**
 * Incremental Server-Sent Events parser.
 *
 * Network chunks arrive at arbitrary byte boundaries: a chunk can end in the
 * middle of a multi-byte UTF-8 character, between the CR and LF of a CRLF, or
 * halfway through a `data:` line. This parser accepts raw bytes and emits
 * complete events only, no matter how the input is sliced.
 *
 * Follows the WHATWG EventSource processing model for the parts that matter
 * in practice: LF, CRLF, and bare-CR line endings; `data:` / `event:` /
 * `id:` / `retry:` fields; multiple data lines joined with "\n"; comment
 * lines starting with ":"; one leading space stripped from field values;
 * events dispatched on blank lines and only when the data buffer is
 * non-empty; last-event-id persisting across events.
 *
 * The parser retains two things between feeds: the current incomplete line,
 * and the data accumulated for the in-flight event. Both are unbounded on a
 * stream that simply never terminates them, so `SseLimits` puts a cap on
 * each, with a deliberate failure mode when a cap is hit: "error" poisons
 * the parser and throws `SseLimitError` (fail closed, tear the stream down),
 * "skip" drops the offending line or event, counts it in `stats`, and keeps
 * parsing what follows. Limits are measured in UTF-16 code units of the
 * decoded stream — the unit the retained strings actually occupy memory in.
 */

export interface SseEvent {
  /** Event type; "message" when the stream never set `event:`. */
  event: string;
  data: string;
  /** Last seen event id at dispatch time, if any id was ever set. */
  id: string | undefined;
  /** Reconnection delay from a `retry:` field on this event, if present. */
  retry: number | undefined;
}

/** Thrown in "error" mode when the stream exceeds a configured limit. */
export class SseLimitError extends Error {
  constructor(
    /** Which cap was exceeded. */
    readonly kind: "line" | "event",
    /** The configured cap, in UTF-16 code units. */
    readonly limit: number,
    /** The size that exceeded it (a lower bound while the line is still arriving). */
    readonly observed: number,
  ) {
    super(`sse ${kind} exceeded ${limit} chars (observed ${observed})`);
    this.name = "SseLimitError";
  }
}

export interface SseLimits {
  /**
   * Cap on one line's length. This is the cap that bounds retained memory:
   * a line with no terminator is the thing that grows without it.
   */
  maxLineChars?: number;
  /** Cap on the data accumulated for one event across its `data:` lines. */
  maxEventChars?: number;
  /**
   * What to do when a cap is hit. "error" (the default): the first overflow
   * throws `SseLimitError` and poisons the parser — every later call throws
   * the same error. "skip": drop the offending line or event, count it, and
   * continue with the rest of the stream.
   */
  onLimit?: "error" | "skip";
}

export interface SseParserStats {
  /** Lines dropped for exceeding maxLineChars (skip mode only). */
  droppedLines: number;
  /** Events dropped for exceeding maxEventChars (skip mode only). */
  droppedEvents: number;
  /**
   * High-water mark of retained parser state (incomplete line + in-flight
   * event data), sampled after each append and each drain. Transient copies
   * inside one feed call are not counted.
   */
  retainedCharsHighWater: number;
}

function checkCap(name: string, value: number | undefined): number {
  if (value === undefined) return Infinity;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer, got ${value}`);
  }
  return value;
}

export class SseParser {
  private readonly decoder = new TextDecoder("utf-8");
  private readonly maxLineChars: number;
  private readonly maxEventChars: number;
  private readonly onLimit: "error" | "skip";
  private buffer = "";
  private dataLines: string[] = [];
  private dataChars = 0;
  private eventType = "";
  private lastId: string | undefined = undefined;
  private retry: number | undefined = undefined;
  private firstLine = true;
  private discardingLine = false;
  private pendingLfSwallow = false;
  private eventOverflowed = false;
  private failure: SseLimitError | null = null;
  private droppedLines = 0;
  private droppedEvents = 0;
  private retainedHighWater = 0;

  constructor(limits?: SseLimits) {
    this.maxLineChars = checkCap("maxLineChars", limits?.maxLineChars);
    this.maxEventChars = checkCap("maxEventChars", limits?.maxEventChars);
    this.onLimit = limits?.onLimit ?? "error";
  }

  get stats(): SseParserStats {
    return {
      droppedLines: this.droppedLines,
      droppedEvents: this.droppedEvents,
      retainedCharsHighWater: this.retainedHighWater,
    };
  }

  /** Feed one network chunk; returns every event completed by this chunk. */
  feed(bytes: Uint8Array): SseEvent[] {
    if (this.failure) throw this.failure;
    // stream:true holds back incomplete UTF-8 sequences until the next chunk.
    return this.ingest(this.decoder.decode(bytes, { stream: true }), false);
  }

  /** Signal end of stream; returns events completed by any buffered tail. */
  end(): SseEvent[] {
    if (this.failure) throw this.failure;
    const events = this.ingest(this.decoder.decode(), true);
    // Per spec, an incomplete final line is discarded, not processed.
    this.buffer = "";
    return events;
  }

  private ingest(decoded: string, atEof: boolean): SseEvent[] {
    let text = decoded;
    if (this.pendingLfSwallow && text.length > 0) {
      // The previous chunk ended a discarded line on a CR; a leading LF here
      // is the second half of that CRLF, not a new line ending.
      this.pendingLfSwallow = false;
      if (text[0] === "\n") text = text.slice(1);
    }
    if (this.discardingLine) {
      text = this.consumeDiscarded(text, atEof);
      if (this.discardingLine) {
        this.noteRetained();
        return [];
      }
    }
    this.buffer += text;
    this.noteRetained();
    const events = this.drain(atEof);
    // A trailing CR is an unclassified terminator, not part of the line.
    const endsOnCr = this.buffer.endsWith("\r");
    const lineChars = endsOnCr ? this.buffer.length - 1 : this.buffer.length;
    if (!atEof && lineChars > this.maxLineChars) {
      if (this.onLimit === "error") {
        this.fail(new SseLimitError("line", this.maxLineChars, lineChars));
      }
      this.droppedLines++;
      this.buffer = "";
      if (endsOnCr) {
        // The CR completed the over-limit line; only a following LF is owed.
        this.pendingLfSwallow = true;
      } else {
        // The line is still arriving; swallow it up to its terminator.
        this.discardingLine = true;
      }
    }
    this.noteRetained();
    return events;
  }

  /** Swallow the rest of an over-limit line; returns whatever follows it. */
  private consumeDiscarded(text: string, atEof: boolean): string {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "\n") {
        this.discardingLine = false;
        return text.slice(i + 1);
      }
      if (ch === "\r") {
        this.discardingLine = false;
        if (i === text.length - 1) {
          if (!atEof) this.pendingLfSwallow = true;
          return "";
        }
        return text.slice(text[i + 1] === "\n" ? i + 2 : i + 1);
      }
    }
    return "";
  }

  private noteRetained(): void {
    const retained = this.buffer.length + this.dataChars;
    if (retained > this.retainedHighWater) this.retainedHighWater = retained;
  }

  private overflowLine(observed: number): void {
    if (this.onLimit === "error") {
      this.fail(new SseLimitError("line", this.maxLineChars, observed));
    }
    this.droppedLines++;
  }

  private overflowEvent(observed: number): void {
    if (this.onLimit === "error") {
      this.fail(new SseLimitError("event", this.maxEventChars, observed));
    }
    this.droppedEvents++;
    this.dataLines = [];
    this.dataChars = 0;
    this.eventOverflowed = true;
  }

  private fail(error: SseLimitError): never {
    this.failure = error;
    this.buffer = "";
    this.dataLines = [];
    this.dataChars = 0;
    throw error;
  }

  private drain(atEof: boolean): SseEvent[] {
    const events: SseEvent[] = [];
    let start = 0;
    for (let i = start; i < this.buffer.length; i++) {
      const ch = this.buffer[i];
      if (ch === "\n") {
        this.processLine(this.buffer.slice(start, i), events);
        start = i + 1;
      } else if (ch === "\r") {
        if (i === this.buffer.length - 1 && !atEof) {
          // Chunk ends exactly on CR: cannot tell CRLF from bare CR yet.
          break;
        }
        this.processLine(this.buffer.slice(start, i), events);
        if (this.buffer[i + 1] === "\n") i++;
        start = i + 1;
      }
    }
    this.buffer = this.buffer.slice(start);
    return events;
  }

  private processLine(rawLine: string, events: SseEvent[]): void {
    let line = rawLine;
    if (this.firstLine) {
      this.firstLine = false;
      if (line.startsWith("\uFEFF")) line = line.slice(1);
    }
    if (line.length > this.maxLineChars) {
      this.overflowLine(line.length);
      return;
    }
    if (line === "") {
      if (!this.eventOverflowed && this.dataLines.length > 0) {
        events.push({
          event: this.eventType === "" ? "message" : this.eventType,
          data: this.dataLines.join("\n"),
          id: this.lastId,
          retry: this.retry,
        });
      }
      this.dataLines = [];
      this.dataChars = 0;
      this.eventType = "";
      this.retry = undefined;
      this.eventOverflowed = false;
      return;
    }
    if (line.startsWith(":")) return; // comment

    const colon = line.indexOf(":");
    const name = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    switch (name) {
      case "data": {
        if (this.eventOverflowed) break;
        const joined = this.dataChars + (this.dataLines.length > 0 ? 1 : 0) + value.length;
        if (joined > this.maxEventChars) {
          this.overflowEvent(joined);
          break;
        }
        this.dataLines.push(value);
        this.dataChars = joined;
        break;
      }
      case "event":
        this.eventType = value;
        break;
      case "id":
        if (!value.includes("\u0000")) this.lastId = value;
        break;
      case "retry":
        if (/^\d+$/.test(value)) this.retry = Number(value);
        break;
      default:
        break; // unknown fields are ignored
    }
  }
}

/** Parse a fully-buffered SSE stream in one call (reference path for tests). */
export function parseSseComplete(bytes: Uint8Array): SseEvent[] {
  const parser = new SseParser();
  return [...parser.feed(bytes), ...parser.end()];
}
