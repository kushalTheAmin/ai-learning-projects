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

export class SseParser {
  private readonly decoder = new TextDecoder("utf-8");
  private buffer = "";
  private dataLines: string[] = [];
  private eventType = "";
  private lastId: string | undefined = undefined;
  private retry: number | undefined = undefined;
  private firstLine = true;

  /** Feed one network chunk; returns every event completed by this chunk. */
  feed(bytes: Uint8Array): SseEvent[] {
    // stream:true holds back incomplete UTF-8 sequences until the next chunk.
    this.buffer += this.decoder.decode(bytes, { stream: true });
    return this.drain(false);
  }

  /** Signal end of stream; returns events completed by any buffered tail. */
  end(): SseEvent[] {
    this.buffer += this.decoder.decode();
    const events = this.drain(true);
    // Per spec, an incomplete final line is discarded, not processed.
    this.buffer = "";
    return events;
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
    if (line === "") {
      if (this.dataLines.length > 0) {
        events.push({
          event: this.eventType === "" ? "message" : this.eventType,
          data: this.dataLines.join("\n"),
          id: this.lastId,
          retry: this.retry,
        });
      }
      this.dataLines = [];
      this.eventType = "";
      this.retry = undefined;
      return;
    }
    if (line.startsWith(":")) return; // comment

    const colon = line.indexOf(":");
    const name = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    switch (name) {
      case "data":
        this.dataLines.push(value);
        break;
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
