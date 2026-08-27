import { describe, expect, it } from "vitest";
import { estimateTokens } from "../../08-agent-tool-loop/src/messages.js";
import { createRng } from "../../05-token-streaming/src/rng.js";
import { DEFAULT_CACHE_CONFIG } from "../src/cache.js";
import {
  SYSTEM_PROMPT_TEXT,
  TOOL_DEFS_TEXT,
  exponentialArrivals,
  makeConversation,
  makeOneShotRequests,
  renderConversation,
} from "../src/workload.js";

describe("makeConversation", () => {
  it("is deterministic for a seed and differs across seeds", () => {
    const a = makeConversation(42, 6, 3);
    const b = makeConversation(42, 6, 3);
    const c = makeConversation(43, 6, 3);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it("produces the requested turn and tool block counts", () => {
    const turns = makeConversation(1, 4, 5);
    expect(turns).toHaveLength(4);
    for (const turn of turns) {
      expect(turn.toolBlockTexts).toHaveLength(5);
      expect(turn.userText.length).toBeGreaterThan(0);
      expect(turn.assistantText.length).toBeGreaterThan(0);
    }
  });

  it("handles zero turns and a single turn", () => {
    expect(makeConversation(1, 0)).toEqual([]);
    expect(makeConversation(1, 1)).toHaveLength(1);
  });
});

describe("renderConversation", () => {
  it("grows each request by the previous turn's full exchange", () => {
    const turns = makeConversation(5, 3, 2);
    const requests = renderConversation(turns);
    // request i: tools + system + i prior exchanges of (user + 2 tool + assistant) + current user
    expect(requests.map((r) => r.blocks.length)).toEqual([3, 7, 11]);
    for (const request of requests) {
      expect(request.blocks[0]!.text).toBe(TOOL_DEFS_TEXT);
      expect(request.blocks[1]!.text).toBe(SYSTEM_PROMPT_TEXT);
      expect(request.staticPrefixEnd).toBe(1);
      expect(request.outputTokens).toBeGreaterThan(0);
    }
  });

  it("keeps earlier requests as exact prefixes of later ones", () => {
    const requests = renderConversation(makeConversation(9, 4));
    for (let i = 1; i < requests.length; i++) {
      const prev = requests[i - 1]!.blocks;
      const next = requests[i]!.blocks;
      // everything but the previous request's trailing user message reappears verbatim
      for (let j = 0; j < prev.length - 1; j++) {
        expect(next[j]!.text).toBe(prev[j]!.text);
      }
    }
  });

  it("makes the system block unique per request under a volatile header", () => {
    const turns = makeConversation(5, 3);
    const stable = renderConversation(turns);
    const volatileA = renderConversation(turns, { volatileHeader: true, headerSalt: 0 });
    const volatileB = renderConversation(turns, { volatileHeader: true, headerSalt: 1 });
    const stableTexts = new Set(stable.map((r) => r.blocks[1]!.text));
    expect(stableTexts.size).toBe(1);
    const volatileTexts = [...volatileA, ...volatileB].map((r) => r.blocks[1]!.text);
    expect(new Set(volatileTexts).size).toBe(volatileTexts.length);
  });

  it("has a static prefix above the default minimum cacheable length", () => {
    const staticTokens = estimateTokens(TOOL_DEFS_TEXT) + estimateTokens(SYSTEM_PROMPT_TEXT);
    expect(staticTokens).toBeGreaterThanOrEqual(DEFAULT_CACHE_CONFIG.minCacheableTokens);
  });
});

describe("makeOneShotRequests", () => {
  it("produces unique prompts above the minimum cacheable length", () => {
    const requests = makeOneShotRequests(3, 10, 6_000);
    expect(requests).toHaveLength(10);
    const contexts = new Set(requests.map((r) => r.blocks[0]!.text));
    expect(contexts.size).toBe(10);
    for (const request of requests) {
      expect(estimateTokens(request.blocks[0]!.text)).toBeGreaterThanOrEqual(
        DEFAULT_CACHE_CONFIG.minCacheableTokens,
      );
    }
  });
});

describe("exponentialArrivals", () => {
  it("is deterministic, ordered, and offset by the start time", () => {
    const a = exponentialArrivals(createRng(7), 50, 1_000, 500);
    const b = exponentialArrivals(createRng(7), 50, 1_000, 500);
    expect(a).toEqual(b);
    expect(a).toHaveLength(50);
    expect(a[0]!).toBeGreaterThan(500);
    for (let i = 1; i < a.length; i++) {
      expect(a[i]!).toBeGreaterThan(a[i - 1]!);
    }
  });

  it("averages near the requested mean gap", () => {
    const arrivals = exponentialArrivals(createRng(11), 2_000, 1_000);
    const mean = arrivals[arrivals.length - 1]! / arrivals.length;
    expect(mean).toBeGreaterThan(900);
    expect(mean).toBeLessThan(1_100);
  });
});
