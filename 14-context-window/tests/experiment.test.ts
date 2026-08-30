import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { estimateTokens } from "../../08-agent-tool-loop/src/messages.js";
import { rate, runCell, type CellResult } from "../src/experiment.js";
import { renderTurn, type PolicyConfig } from "../src/policies.js";
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

// The published run, mirroring src/main.ts: BASE_SEED 20260828 over 20
// conversations. Every number quoted in the README comes from this set, so
// the two tests below recompute it rather than trusting the prose.
const PUBLISHED = generateConversations(20260828, 20);

const CLASS_ROWS_800: { label: string; config: PolicyConfig }[] = [
  { label: "sliding-window", config: { name: "sliding-window" } },
  { label: "head-and-tail-4", config: { name: "head-and-tail", headTurns: 4 } },
  { label: "summ-luhn-25%", config: { name: "summarize-evicted", summaryShare: 0.25, summarizer: "luhn" } },
  { label: "summ-rarity-25%", config: { name: "summarize-evicted", summaryShare: 0.25, summarizer: "rarity" } },
];

/** Two-proportion z for standalone vs buried retention on one row. */
function classGapZ(r: CellResult): number {
  const s = r.byClass.standalone;
  const b = r.byClass.buried;
  const pooled = (s.hits + b.hits) / (s.total + b.total);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / s.total + 1 / b.total));
  return se === 0 ? 0 : (rate(s) - rate(b)) / se;
}

describe("standalone vs buried retention", () => {
  // The README used to say buried facts pay a tax under every policy that
  // scores sentences and that the window policies "dont care". Both halves
  // are refuted by the run: luhn holds buried facts BETTER than standalone,
  // and plain sliding-window has the widest split of any row. Pin the signs
  // so the mechanism story cannot be reasserted.
  test("the split has no consistent sign across policies at budget 800", () => {
    const gaps = new Map<string, number>();
    for (const { label, config } of CLASS_ROWS_800) {
      const r = runCell(config, label, 800, PUBLISHED);
      gaps.set(label, rate(r.byClass.standalone) - rate(r.byClass.buried));
    }
    // sentence-scoring policies do not agree with each other
    expect(gaps.get("summ-luhn-25%")!).toBeLessThan(0);
    expect(gaps.get("summ-rarity-25%")!).toBeGreaterThan(0);
    // and the widest split belongs to a policy that never looks at a sentence
    expect(gaps.get("sliding-window")!).toBeGreaterThan(gaps.get("summ-rarity-25%")!);
  });

  test("no row in the published sweep clears two standard errors", () => {
    for (const budget of [400, 800, 1600, 3200]) {
      for (const { label, config } of CLASS_ROWS_800) {
        const z = classGapZ(runCell(config, label, budget, PUBLISHED));
        expect(Math.abs(z), `${label}@${budget} z=${z}`).toBeLessThan(2);
      }
    }
  });

  test("README quotes the per-class numbers the run actually produces", () => {
    const quoted = (label: string): [string, string] => {
      const r = runCell(CLASS_ROWS_800.find((c) => c.label === label)!.config, label, 800, PUBLISHED);
      return [`${(100 * rate(r.byClass.standalone)).toFixed(1)}%`, `${(100 * rate(r.byClass.buried)).toFixed(1)}%`];
    };
    const [rarS, rarB] = quoted("summ-rarity-25%");
    const [luhnS, luhnB] = quoted("summ-luhn-25%");
    const [slideS, slideB] = quoted("sliding-window");
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf-8");
    const bullet = readme.split("\n").find((l) => l.includes("standalone vs buried"));
    expect(bullet, "README has no standalone-vs-buried bullet").toBeDefined();
    expect(bullet).toContain(`${rarS} of standalone facts against ${rarB} of buried ones`);
    expect(bullet).toContain(`(${luhnS} standalone, ${luhnB} buried)`);
    expect(bullet).toContain(`(${slideS} vs ${slideB})`);
  });

  test("README quotes the widest gap and the turn sizes, neither of which main.ts prints", () => {
    // These four figures are derived, not columns of the run, so nothing else
    // would catch them going stale. rarity-25% at 400 is the widest split in
    // the sweep; the turn-size pair is the mechanism the bullet names.
    const widest = runCell(
      { name: "summarize-evicted", summaryShare: 0.25, summarizer: "rarity" },
      "summ-rarity-25%",
      400,
      PUBLISHED,
    );
    const gapPoints = 100 * (rate(widest.byClass.standalone) - rate(widest.byClass.buried));
    const byClass = {
      standalone: { tokens: 0, n: 0 },
      buried: { tokens: 0, n: 0 },
    };
    for (const c of PUBLISHED) {
      for (const f of c.facts) {
        byClass[f.cls].tokens += estimateTokens(renderTurn(c.turns[2 * f.introExchange + 1]!));
        byClass[f.cls].n += 1;
      }
    }
    const mean = (cls: "standalone" | "buried"): string => (byClass[cls].tokens / byClass[cls].n).toFixed(1);

    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf-8");
    const bullet = readme.split("\n").find((l) => l.includes("standalone vs buried"))!;
    expect(bullet).toContain(`${gapPoints.toFixed(1)} points at z=${classGapZ(widest).toFixed(2)}`);
    expect(bullet).toContain(`${mean("buried")} tokens against a standalone one's ${mean("standalone")}`);
  });
});
