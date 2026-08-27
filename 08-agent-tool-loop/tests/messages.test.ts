import { describe, expect, it } from "vitest";
import { canonical, costUsd, estimateTokens, historyTokens, messageTokens, type Message } from "../src/messages.js";

describe("canonical", () => {
  it("sorts object keys so call identity ignores key order", () => {
    expect(canonical({ b: 1, a: 2 })).toBe(canonical({ a: 2, b: 1 }));
    expect(canonical({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("sorts nested object keys", () => {
    expect(canonical({ x: { b: 1, a: 2 } })).toBe('{"x":{"a":2,"b":1}}');
  });

  it("keeps array order", () => {
    expect(canonical([2, 1])).toBe("[2,1]");
  });
});

describe("estimateTokens", () => {
  it("rounds up at ~4 chars per token", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("never returns zero, even for empty text", () => {
    expect(estimateTokens("")).toBe(1);
  });
});

describe("history and cost accounting", () => {
  it("history tokens are the sum of message tokens", () => {
    const history: Message[] = [
      { role: "user", text: "add 1 and 2" },
      { role: "assistant", turn: { type: "final", answer: "3" } },
    ];
    expect(historyTokens(history)).toBe(messageTokens(history[0]!) + messageTokens(history[1]!));
  });

  it("prices input and output at their own rates", () => {
    expect(costUsd(1_000_000, 0, { inputPerMTok: 3, outputPerMTok: 15 })).toBe(3);
    expect(costUsd(0, 1_000_000, { inputPerMTok: 3, outputPerMTok: 15 })).toBe(15);
    expect(costUsd(500_000, 100_000, { inputPerMTok: 3, outputPerMTok: 15 })).toBeCloseTo(3, 10);
  });
});
