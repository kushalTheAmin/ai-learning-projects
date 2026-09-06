import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { estimateTokens } from "../../08-agent-tool-loop/src/messages.js";
import { runCell } from "../src/experiment.js";
import { IncrementalAssembler } from "../src/incremental.js";
import { runIncrementalCell } from "../src/irreversibility.js";
import { assembleContext, renderTurn, type Turn } from "../src/policies.js";
import { generateConversations } from "../src/workload.js";

const SYSTEM = "you are the on-call assistant.";

function turn(role: "user" | "assistant", text: string): Turn {
  return { role, text };
}

function history(n: number): Turn[] {
  const out: Turn[] = [];
  for (let i = 0; i < n; i++) {
    out.push(turn(i % 2 === 0 ? "user" : "assistant", `turn number ${i} says filler words here.`));
  }
  return out;
}

/** Turns whose every sentence carries a unique nonce, so presence is checkable. */
function nonceHistory(n: number): Turn[] {
  const out: Turn[] = [];
  for (let i = 0; i < n; i++) {
    out.push(turn(i % 2 === 0 ? "user" : "assistant", `topic${i} carries the marker nonceval${i} today.`));
  }
  return out;
}

const CURRENT = turn("user", "what did we decide?");

function partTokens(parts: readonly string[]): number {
  return parts.reduce((n, p) => n + estimateTokens(p), 0);
}

describe("IncrementalAssembler, shared contract", () => {
  test("system first, current user last, tokens = sum of parts", () => {
    const a = new IncrementalAssembler({ summaryShare: 0.25, summarizer: "rarity" });
    const { ctx } = a.assemble(SYSTEM, history(20), CURRENT, 300);
    expect(ctx.parts[0]).toBe(SYSTEM);
    expect(ctx.parts[ctx.parts.length - 1]).toBe(renderTurn(CURRENT));
    expect(ctx.tokens).toBe(partTokens(ctx.parts));
  });

  test("never exceeds the budget across a whole turn-by-turn conversation", () => {
    for (const budget of [120, 200, 400, 800]) {
      const a = new IncrementalAssembler({ summaryShare: 0.25, summarizer: "rarity" });
      const h = history(40);
      const grown: Turn[] = [];
      for (let i = 0; i < h.length; i += 2) {
        const { ctx } = a.assemble(SYSTEM, grown, h[i] as Turn, budget);
        expect(ctx.overBudget).toBe(false);
        expect(ctx.tokens).toBeLessThanOrEqual(budget);
        grown.push(h[i] as Turn, h[i + 1] as Turn);
      }
    }
  });

  test("while everything fits: whole history kept, no summary block", () => {
    const a = new IncrementalAssembler({ summaryShare: 0.25, summarizer: "rarity" });
    const h = history(4);
    const { ctx, stats } = a.assemble(SYSTEM, h, CURRENT, 10_000);
    expect(ctx.keptTurns).toEqual(h);
    expect(ctx.summarySentences).toEqual([]);
    expect(stats.compacted).toBe(false);
    expect(a.foldedTurns()).toBe(0);
  });

  test("empty history: just the pinned parts", () => {
    const a = new IncrementalAssembler();
    const { ctx } = a.assemble(SYSTEM, [], CURRENT, 200);
    expect(ctx.parts).toEqual([SYSTEM, renderTurn(CURRENT)]);
    expect(ctx.overBudget).toBe(false);
  });

  test("hopeless budget: overBudget set, no history, state untouched", () => {
    const a = new IncrementalAssembler();
    const { ctx, stats } = a.assemble(SYSTEM, history(10), CURRENT, 10);
    expect(ctx.overBudget).toBe(true);
    expect(ctx.keptTurns).toEqual([]);
    expect(stats.compacted).toBe(false);
    expect(a.foldedTurns()).toBe(0);
  });

  test("unicode turn text survives assembly", () => {
    const a = new IncrementalAssembler({ summarizer: "rarity" });
    const h = [turn("user", "das Café öffnet früh. наши метрики стабильны."), turn("assistant", "noted — 東京リージョンは安定。")];
    const { ctx } = a.assemble(SYSTEM, h, CURRENT, 10_000);
    expect(ctx.parts.join("\n")).toContain("東京リージョン");
  });
});

describe("first compaction matches the stateless policy exactly", () => {
  test("same parts on the call where eviction first happens", () => {
    for (const scorer of ["luhn", "rarity"] as const) {
      const a = new IncrementalAssembler({ summaryShare: 0.25, summarizer: scorer });
      const h = history(20);
      const { ctx } = a.assemble(SYSTEM, h, CURRENT, 300);
      const stateless = assembleContext(
        { name: "summarize-evicted", summaryShare: 0.25, summarizer: scorer },
        SYSTEM,
        h,
        CURRENT,
        300,
      );
      expect(ctx.parts).toEqual(stateless.parts);
      expect(ctx.summaryWorkTokens).toBe(stateless.summaryWorkTokens);
    }
  });
});

describe("irreversibility", () => {
  test("folded turns never come back, however much room a later call has", () => {
    const a = new IncrementalAssembler({ summaryShare: 0.25, summarizer: "rarity" });
    const h = nonceHistory(24);
    a.assemble(SYSTEM, h, CURRENT, 250);
    const folded = a.foldedTurns();
    expect(folded).toBeGreaterThan(0);
    const { ctx } = a.assemble(SYSTEM, h, CURRENT, 100_000);
    for (const t of h.slice(0, folded)) {
      expect(ctx.keptTurns).not.toContainEqual(t);
    }
    expect(a.foldedTurns()).toBe(folded);
  });

  test("a sentence the packer dropped is gone even when the budget recovers", () => {
    const a = new IncrementalAssembler({ summaryShare: 0.25, summarizer: "rarity" });
    const h = nonceHistory(24);
    a.assemble(SYSTEM, h, CURRENT, 250);
    const folded = a.foldedTurns();
    const kept = new Set(a.summarySentences());
    const droppedTurn = h.slice(0, folded).find((t) => !kept.has(t.text));
    expect(droppedTurn, "the tight call dropped at least one folded sentence").toBeDefined();

    // The stateless policy at the recovered budget still has the turn's text
    // available; the incremental assembler does not.
    const bigBudget = 100_000;
    const stateless = assembleContext(
      { name: "summarize-evicted", summaryShare: 0.25, summarizer: "rarity" },
      SYSTEM,
      h,
      CURRENT,
      bigBudget,
    );
    const { ctx } = a.assemble(SYSTEM, h, CURRENT, bigBudget);
    expect(stateless.parts.join("\n")).toContain((droppedTurn as Turn).text);
    expect(ctx.parts.join("\n")).not.toContain((droppedTurn as Turn).text);
  });

  test("a transiently long user turn forces a shrink repack that sticks", () => {
    const a = new IncrementalAssembler({ summaryShare: 0.5, summarizer: "rarity" });
    const h = nonceHistory(24);
    a.assemble(SYSTEM, h, CURRENT, 150);
    const folded = a.foldedTurns();
    expect(folded).toBeGreaterThan(0);
    const before = a.summarySentences().length;
    expect(before).toBeGreaterThan(1);

    // Only already-folded turns in view, so the tighter call has nothing new
    // to fold: the summary itself must give the room back.
    const longUser = turn("user", `please summarize ${"the whole situation ".repeat(7)}right now for me.`);
    const { stats } = a.assemble(SYSTEM, h.slice(0, folded), longUser, 150);
    expect(stats.compacted).toBe(true);
    expect(stats.shrinkRepack).toBe(true);
    expect(stats.droppedSentences).toBeGreaterThan(0);
    const shrunk = a.summarySentences().length;
    expect(shrunk).toBeLessThan(before);

    // Room recovers; the sentences the shrink discarded do not.
    const { stats: after } = a.assemble(SYSTEM, h.slice(0, folded), CURRENT, 150);
    expect(after.compacted).toBe(false);
    expect(a.summarySentences().length).toBe(shrunk);
  });

  test("shrink repacks happen in the real workload too, not just by construction", () => {
    const convs = generateConversations(20260828, 20, { exchanges: 30, factCount: 12 });
    const r = runIncrementalCell({ summaryShare: 0.25, summarizer: "rarity" }, "inc", 400, convs);
    expect(r.shrinkRepacks).toBeGreaterThan(0);
  });
});

// The README used to quote "2 to 3 such shrink repacks per 20-conversation
// cell here, pinned by a test". No entry point printed the count, the test it
// named only asserted one cell is above zero, and the run says 0 to 6 across
// the twelve published cells with three of them at exactly 0. These tests own
// the number: they recompute every published cell and hold the README to it.
const PUB_SEED = 20260828;
const PUB_CONVS = 20;
const REGIME_BUDGETS = [400, 800, 1600] as const;
const SCORERS = ["luhn", "rarity"] as const;

const standardConvs = generateConversations(PUB_SEED, PUB_CONVS, { exchanges: 30, factCount: 12 });
const longConvs = generateConversations(PUB_SEED + 1_000_003, PUB_CONVS, { exchanges: 60, factCount: 12 });

function shrinks(convs: typeof standardConvs, summarizer: "luhn" | "rarity", share: number, budget: number): number {
  return runIncrementalCell({ summaryShare: share, summarizer }, "inc", budget, convs).shrinkRepacks;
}

/** Rows of the README's three printed tables, keyed by the block heading. */
function readmeBlocks(): Map<string, string[][]> {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf-8");
  const blocks = new Map<string, string[][]>();
  let current: string[][] | null = null;
  for (const line of readme.split("\n")) {
    const heading = line.match(/^=== (.+) ===$/);
    if (heading !== null) {
      current = [];
      blocks.set(heading[1] as string, current);
      continue;
    }
    if (current !== null && /^(increm|recompute)-/.test(line)) current.push(line.trim().split(/\s+/));
  }
  return blocks;
}

const SHRINK_COL = 9;

describe("the shrink-repack count is printed and quoted as the run has it", () => {
  test("the twelve published share-25% cells run 0 to 6, three of them at zero", () => {
    const counts: number[] = [];
    for (const convs of [standardConvs, longConvs]) {
      for (const scorer of SCORERS) {
        for (const budget of REGIME_BUDGETS) counts.push(shrinks(convs, scorer, 0.25, budget));
      }
    }
    expect(counts).toEqual([6, 3, 0, 2, 2, 0, 2, 0, 1, 3, 2, 1]);
    expect(Math.min(...counts)).toBe(0);
    expect(Math.max(...counts)).toBe(6);
    expect(counts.filter((c) => c === 0)).toHaveLength(3);
  });

  test("the count climbs with the summary share, it is not a fixed rate", () => {
    const atShare = (share: number): number[] => SCORERS.map((s) => shrinks(longConvs, s, share, 800));
    expect(atShare(0.1)).toEqual([0, 1]);
    expect(atShare(0.25)).toEqual([0, 2]);
    expect(atShare(0.5)).toEqual([11, 7]);
  });

  test("every incremental row in the README carries its own cell's shrink count", () => {
    const blocks = readmeBlocks();
    const cases: { block: string; label: string; budget: number; count: number }[] = [];
    for (const [block, convs] of [
      ["standard regime (30 exchanges): recompute vs incremental at summary share 25%", standardConvs],
      ["long regime (60 exchanges): recompute vs incremental at summary share 25%", longConvs],
    ] as const) {
      for (const scorer of SCORERS) {
        for (const budget of REGIME_BUDGETS) {
          cases.push({ block, label: `increm-${scorer}-25%`, budget, count: shrinks(convs, scorer, 0.25, budget) });
        }
      }
    }
    expect(cases).toHaveLength(12);
    for (const c of cases) {
      const rows = blocks.get(c.block);
      expect(rows, `README has no block "${c.block}"`).toBeDefined();
      const row = (rows as string[][]).find((r) => r[0] === c.label && r[1] === String(c.budget));
      expect(row, `${c.block}: no row for ${c.label} at ${c.budget}`).toBeDefined();
      expect((row as string[])[SHRINK_COL], `${c.block} ${c.label}@${c.budget}`).toBe(String(c.count));
    }
  });

  test("recompute rows have no shrink cell, the mechanism is incremental-only", () => {
    for (const rows of readmeBlocks().values()) {
      for (const row of rows.filter((r) => (r[0] as string).startsWith("recompute-"))) {
        expect(row[SHRINK_COL], row.join(" ")).toBe("-");
      }
    }
  });

  test("the README bullet states the measured spread, not a fixed 2 to 3", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf-8");
    const bullet = readme.split("\n").find((l) => l.includes("permanently shrinks the summary"));
    expect(bullet, "README has no shrink-repack bullet").toBeDefined();
    expect(bullet).not.toContain("2 to 3");
    expect(bullet).not.toContain("pinned by a test");
    expect(bullet).toContain("0 to 6");
    expect(bullet).toContain("exactly 0 in three of them");
    expect(bullet).toContain("11 and 7");
  });
});

describe("runIncrementalCell against runCell, pinned", () => {
  // 5 conversations, 30 exchanges, 60 probes; every number below is pinned
  // from a run and must reproduce exactly.
  const CONVS = generateConversations(500, 5);

  test("rarity 25% at 400: retention, work, and drops", () => {
    const inc = runIncrementalCell({ summaryShare: 0.25, summarizer: "rarity" }, "inc", 400, CONVS);
    expect(inc.overall).toEqual({ hits: 32, total: 60 });
    expect(inc.byBucket.long).toEqual({ hits: 1, total: 20 });
    expect(inc.summaryWorkTokens).toBe(15501);
    expect(inc.compactions).toBe(121);
    expect(inc.droppedSentences).toBe(343);
    expect(inc.totalInputTokens).toBe(52359);
    expect(inc.overBudgetCalls).toBe(0);
  });

  test("recompute pays multiples of incremental's read bill for its retention edge", () => {
    for (const budget of [400, 800]) {
      const rec = runCell({ name: "summarize-evicted", summaryShare: 0.25, summarizer: "rarity" }, "rec", budget, CONVS);
      const inc = runIncrementalCell({ summaryShare: 0.25, summarizer: "rarity" }, "inc", budget, CONVS);
      expect(rec.overall.hits).toBeGreaterThan(inc.overall.hits);
      expect(rec.summaryWorkTokens).toBeGreaterThan(3 * inc.summaryWorkTokens);
    }
  });

  test("recompute work at 400 is pinned so the ratio cannot drift silently", () => {
    const rec = runCell({ name: "summarize-evicted", summaryShare: 0.25, summarizer: "rarity" }, "rec", 400, CONVS);
    expect(rec.overall).toEqual({ hits: 39, total: 60 });
    expect(rec.summaryWorkTokens).toBe(111361);
    expect(rec.compactions).toBe(128);
  });

  test("deterministic: the same cell twice is identical", () => {
    const a = runIncrementalCell({ summaryShare: 0.25, summarizer: "rarity" }, "inc", 800, CONVS);
    const b = runIncrementalCell({ summaryShare: 0.25, summarizer: "rarity" }, "inc", 800, CONVS);
    expect(a).toEqual(b);
  });

  test("cost formula matches the shared pricing arithmetic", () => {
    const r = runIncrementalCell({ summaryShare: 0.25, summarizer: "rarity" }, "inc", 800, CONVS);
    const expected = ((r.totalInputTokens / 1e6) * 3 + (r.totalOutputTokens / 1e6) * 15) / CONVS.length;
    expect(r.costPerConversation).toBeCloseTo(expected, 12);
  });
});
