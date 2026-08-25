/**
 * Assembles a message from a stream of SSE events, exposing a live snapshot
 * after every event: accumulated text plus tool-call arguments parsed
 * best-effort from the JSON prefix received so far.
 *
 * The event shapes mirror the Anthropic streaming protocol: content blocks
 * opened by `content_block_start`, grown by `content_block_delta` events
 * carrying either `text_delta` or `input_json_delta`, and closed by
 * `content_block_stop`. Each SSE event's own `data` payload is a complete
 * JSON document — the protocol only ever streams *tool argument* JSON in
 * pieces, which is exactly why the partial parser exists.
 */

import { parsePartialJson, type PartialParseResult } from "./partial-json.js";
import type { SseEvent } from "./sse.js";

interface TextBlock {
  type: "text";
  text: string;
}

interface ToolUseBlock {
  type: "tool_use";
  name: string;
  argsJson: string;
}

type Block = TextBlock | ToolUseBlock;

export interface ToolCallSnapshot {
  name: string;
  argsJson: string;
  args: unknown;
  argsComplete: boolean;
}

export interface MessageSnapshot {
  text: string;
  toolCalls: ToolCallSnapshot[];
  done: boolean;
}

export class MessageAssembler {
  private readonly blocks = new Map<number, Block>();
  private done = false;

  handle(event: SseEvent): void {
    const payload: unknown = JSON.parse(event.data);
    if (typeof payload !== "object" || payload === null) {
      throw new Error(`event payload is not an object: ${event.data}`);
    }
    const p = payload as Record<string, unknown>;

    switch (event.event) {
      case "message_start":
        break;
      case "content_block_start":
        this.startBlock(requireNumber(p["index"]), p["content_block"]);
        break;
      case "content_block_delta":
        this.applyDelta(requireNumber(p["index"]), p["delta"]);
        break;
      case "content_block_stop":
        break;
      case "message_stop":
        this.done = true;
        break;
      default:
        throw new Error(`unknown event type: ${event.event}`);
    }
  }

  private startBlock(index: number, raw: unknown): void {
    const block = raw as Record<string, unknown> | null;
    if (block === null || typeof block !== "object") {
      throw new Error("content_block_start missing content_block");
    }
    if (block["type"] === "text") {
      this.blocks.set(index, { type: "text", text: "" });
    } else if (block["type"] === "tool_use") {
      this.blocks.set(index, {
        type: "tool_use",
        name: String(block["name"]),
        argsJson: "",
      });
    } else {
      throw new Error(`unknown content block type: ${String(block["type"])}`);
    }
  }

  private applyDelta(index: number, raw: unknown): void {
    const block = this.blocks.get(index);
    if (block === undefined) throw new Error(`delta for unopened block ${index}`);
    const delta = raw as Record<string, unknown> | null;
    if (delta === null || typeof delta !== "object") {
      throw new Error("content_block_delta missing delta");
    }
    if (delta["type"] === "text_delta" && block.type === "text") {
      block.text += String(delta["text"]);
    } else if (delta["type"] === "input_json_delta" && block.type === "tool_use") {
      block.argsJson += String(delta["partial_json"]);
    } else {
      throw new Error(
        `delta type ${String(delta["type"])} does not match block type ${block.type}`,
      );
    }
  }

  snapshot(): MessageSnapshot {
    let text = "";
    const toolCalls: ToolCallSnapshot[] = [];
    const indexes = [...this.blocks.keys()].sort((a, b) => a - b);
    for (const index of indexes) {
      const block = this.blocks.get(index);
      if (block === undefined) continue;
      if (block.type === "text") {
        text += block.text;
      } else {
        const parsed: PartialParseResult =
          block.argsJson === ""
            ? { value: undefined, complete: false }
            : parsePartialJson(block.argsJson);
        toolCalls.push({
          name: block.name,
          argsJson: block.argsJson,
          args: parsed.value,
          argsComplete: parsed.complete,
        });
      }
    }
    return { text, toolCalls, done: this.done };
  }
}

function requireNumber(value: unknown): number {
  if (typeof value !== "number") throw new Error(`expected number, got ${String(value)}`);
  return value;
}
