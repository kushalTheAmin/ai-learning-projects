import { describe, expect, test } from "vitest";
import { estimateTokens } from "../../08-agent-tool-loop/src/messages.js";
import { rate, runCell } from "../src/experiment.js";
import { renderTurn } from "../src/policies.js";
import { generateConversations } from "../src/workload.js";

// Small fixed set shared by every test in this file: 5 conversations,
// 30 exchanges, 12 probes each. All numbers below are pinned from a run
// and must reproduce exactly; they exist so a broken policy, token count,
// or probe check cannot pass unnoticed.
const CONVS = generateConversations(500, 5);

describe("runCell end to end", () => {
  test("full-history answers every probe", () => {
    const r = runCell({ name: "full-history" }, "full", Number.MAX_SAFE_INTEGER, CONVS);
    expect(r.overall).toEqual({ hits: 60, total: 60 });
    expect(r.overBudgetCalls).toBe(0);
  });

  test("sliding-window at 400: pinned retention and token totals", () => {
    const r = runCell({ name: "sliding-window" }, "slide", 400, CONVS);
    expect(r.overall).toEqual({ hits: 29, total: 60 });
    expect(r.byBucket.long).toEqual({ hits: 0, total: 20 });
    expect(r.byClass.buried).toEqual({ hits: 15, total: 30 });
    expect(r.totalInputTokens).toBe(53350);
    expect(r.totalOutputTokens).toBe(5217);
    expect(r.overBudgetCalls).toBe(0);
    expect(r.maxInputTokensPerCall).toBeLessThanOrEqual(400);
  });

  test("rarity salience beats luhn salience on this workload at budget 800", () => {
    const luhn = runCell({ name: "summarize-evicted", summaryShare: 0.25, summarizer: "luhn" }, "l", 800, CONVS);
    const rarity = runCell({ name: "summarize-evicted", summaryShare: 0.25, summarizer: "rarity" }, "r", 800, CONVS);
    expect(luhn.overall).toEqual({ hits: 41, total: 60 });
    expect(rarity.overall).toEqual({ hits: 55, total: 60 });
    expect(rate(rarity.overall)).toBeGreaterThan(rate(luhn.overall));
  });

  test("full-history input tokens match an independent recomputation", () => {
    const r = runCell({ name: "full-history" }, "full", Number.MAX_SAFE_INTEGER, CONVS);
    let expected = 0;
    for (const c of CONVS) {
      for (let e = 0; e < c.exchanges; e++) {
        expected += estimateTokens(c.system);
        for (let i = 0; i < 2 * e; i++) expected += estimateTokens(renderTurn(c.turns[i]!));
        expected += estimateTokens(renderTurn(c.turns[2 * e]!));
      }
    }
    expect(r.totalInputTokens).toBe(expected);
  });

  test("cost formula: 3 dollars per MTok in, 15 out, divided by conversation count", () => {
    const r = runCell({ name: "sliding-window" }, "slide", 400, CONVS);
    const expected = ((r.totalInputTokens / 1e6) * 3 + (r.totalOutputTokens / 1e6) * 15) / CONVS.length;
    expect(r.costPerConversation).toBeCloseTo(expected, 12);
  });

  test("mean input tokens per call is total over calls", () => {
    const r = runCell({ name: "sliding-window" }, "slide", 400, CONVS);
    expect(r.meanInputTokensPerCall).toBeCloseTo(r.totalInputTokens / (CONVS.length * 30), 12);
  });

  test("tracked call sizes: full-history grows, a budgeted policy stays flat", () => {
    const full = runCell({ name: "full-history" }, "full", Number.MAX_SAFE_INTEGER, CONVS, [0, 29]);
    const slide = runCell({ name: "sliding-window" }, "slide", 400, CONVS, [0, 29]);
    expect(full.callTokensAtExchange.get(29)!).toBeGreaterThan(3 * full.callTokensAtExchange.get(0)!);
    expect(slide.callTokensAtExchange.get(29)!).toBeLessThanOrEqual(400);
  });

  test("deterministic: the same cell twice is identical", () => {
    const a = runCell({ name: "summarize-evicted", summaryShare: 0.25, summarizer: "rarity" }, "r", 800, CONVS);
    const b = runCell({ name: "summarize-evicted", summaryShare: 0.25, summarizer: "rarity" }, "r", 800, CONVS);
    expect(a).toEqual(b);
  });

  test("a hopeless budget counts over-budget calls instead of crashing", () => {
    const r = runCell({ name: "sliding-window" }, "slide", 10, CONVS.slice(0, 1));
    expect(r.overBudgetCalls).toBeGreaterThan(0);
    expect(r.overall.total).toBe(12);
  });
});
