/**
 * Conversation message types shared by the scripted model, the agent loop,
 * and the accounting. Token counts are a deterministic proxy (~4 chars per
 * token over the serialized message), not a real tokenizer: good enough to
 * compare policies against each other, useless as an absolute price quote.
 */

export type ToolCallTurn = {
  type: "tool_call";
  name: string;
  args: unknown;
};

export type FinalTurn = {
  type: "final";
  answer: string;
};

export type AssistantTurn = ToolCallTurn | FinalTurn;

export type Message =
  | { role: "user"; text: string }
  | { role: "assistant"; turn: AssistantTurn }
  | { role: "tool"; result: ToolResultBody }
  | { role: "validation_error"; text: string };

export interface ToolResultBody {
  ok: boolean;
  value?: string;
  error?: string;
}

/** Stable serialization used for both token counting and call identity. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
      return sorted;
    }
    return v;
  });
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function messageTokens(msg: Message): number {
  return estimateTokens(canonical(msg));
}

/** Input tokens for one model call: the whole history, no caching. */
export function historyTokens(history: readonly Message[]): number {
  let total = 0;
  for (const msg of history) total += messageTokens(msg);
  return total;
}

export interface Pricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

export const PRICING: Pricing = { inputPerMTok: 3, outputPerMTok: 15 };

export function costUsd(tokensIn: number, tokensOut: number, pricing: Pricing = PRICING): number {
  return (tokensIn * pricing.inputPerMTok + tokensOut * pricing.outputPerMTok) / 1_000_000;
}
