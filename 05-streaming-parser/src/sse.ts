/**
 * Incremental server-sent-events parser.
 *
 * Network chunks arrive at arbitrary byte boundaries: a chunk can end in the
 * middle of a line, in the middle of an event, or in the middle of a multi-byte
 * UTF-8 code point. This parser accepts raw bytes and emits only complete
 * events, holding partial state between pushes.
 *
 * Follows the WHATWG SSE spec where it matters here: `data:` lines accumulate
 * and join with newlines, `event:` names the event, comment lines (leading
 * colon) are ignored, a blank line dispatches, and an event left unterminated
 * at end of stream is discarded. Line terminators `\n` and `\r\n` are
 * supported.
 */

export interface SseEvent {
  event: string;
  data: string;
}

export class SseParser {
  private readonly decoder = new TextDecoder("utf-8");
  private buffer = "";
  private dataLines: string[] = [];
  private eventType = "";

  /** Feed one network chunk; returns every event completed by it. */
  push(chunk: Uint8Array): SseEvent[] {
    // stream: true makes the decoder hold incomplete UTF-8 sequences until
    // the next chunk instead of emitting replacement characters.
    this.buffer += this.decoder.decode(chunk, { stream: true });
    return this.drainCompleteLines();
  }

  /** Signal end of stream. Flushes the decoder; discards any unterminated event. */
  end(): SseEvent[] {
    this.buffer += this.decoder.decode();
    const events = this.drainCompleteLines();
    this.buffer = "";
    this.dataLines = [];
    this.eventType = "";
    return events;
  }

  private drainCompleteLines(): SseEvent[] {
    const events: SseEvent[] = [];
    let newlineAt: number;
    while ((newlineAt = this.buffer.indexOf("\n")) !== -1) {
      let line = this.buffer.slice(0, newlineAt);
      this.buffer = this.buffer.slice(newlineAt + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      const event = this.consumeLine(line);
      if (event !== undefined) events.push(event);
    }
    return events;
  }

  private consumeLine(line: string): SseEvent | undefined {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return undefined;

    const colonAt = line.indexOf(":");
    const field = colonAt === -1 ? line : line.slice(0, colonAt);
    let value = colonAt === -1 ? "" : line.slice(colonAt + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "data") this.dataLines.push(value);
    else if (field === "event") this.eventType = value;
    // id and retry are valid SSE fields but unused here.
    return undefined;
  }

  private dispatch(): SseEvent | undefined {
    if (this.dataLines.length === 0) {
      this.eventType = "";
      return undefined;
    }
    const event: SseEvent = {
      event: this.eventType === "" ? "message" : this.eventType,
      data: this.dataLines.join("\n"),
    };
    this.dataLines = [];
    this.eventType = "";
    return event;
  }
}
