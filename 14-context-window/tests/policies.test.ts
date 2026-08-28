import { describe, expect, test } from "vitest";
import { estimateTokens } from "../../08-agent-tool-loop/src/messages.js";
import { assembleContext, renderTurn, type PolicyConfig, type Turn } from "../src/policies.js";

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

const CURRENT = turn("user", "what did we decide?");

function partTokens(parts: readonly string[]): number {
  return parts.reduce((n, p) => n + estimateTokens(p), 0);
}

describe("assembleContext, shared contract", () => {
  const policies: PolicyConfig[] = [
    { name: "full-history" },
    { name: "sliding-window" },
    { name: "head-and-tail", headTurns: 4 },
    { name: "summarize-evicted", summaryShare: 0.25, summarizer: "rarity" },
  ];

  test.each(policies.map((p) => [p.name, p] as const))("%s: system first, current user last, tokens = sum of parts", (_n, policy) => {
    const ctx = assembleContext(policy, SYSTEM, history(20), CURRENT, 300);
    expect(ctx.parts[0]).toBe(SYSTEM);
    expect(ctx.parts[ctx.parts.length - 1]).toBe(renderTurn(CURRENT));
    expect(ctx.tokens).toBe(partTokens(ctx.parts));
  });

  test.each(policies.filter((p) => p.name !== "full-history").map((p) => [p.name, p] as const))(
    "%s: never exceeds the budget when the pinned parts fit",
    (_n, policy) => {
      for (const budget of [120, 200, 400, 800]) {
        const ctx = assembleContext(policy, SYSTEM, history(40), CURRENT, budget);
        expect(ctx.overBudget).toBe(false);
        expect(ctx.tokens).toBeLessThanOrEqual(budget);
      }
    },
  );

  test.each(policies.map((p) => [p.name, p] as const))("%s: empty history works", (_n, policy) => {
    const ctx = assembleContext(policy, SYSTEM, [], CURRENT, 200);
    expect(ctx.parts).toEqual([SYSTEM, renderTurn(CURRENT)]);
    expect(ctx.keptTurns).toEqual([]);
  });

  test("pinned parts over budget: overBudget set, no history kept, still assembled", () => {
    const ctx = assembleContext({ name: "sliding-window" }, SYSTEM, history(10), CURRENT, 5);
    expect(ctx.overBudget).toBe(true);
    expect(ctx.keptTurns).toEqual([]);
    expect(ctx.parts).toEqual([SYSTEM, renderTurn(CURRENT)]);
  });

  test("unicode turn text passes through untouched", () => {
    const h = [turn("assistant", "the naïve café plan is zoné-λ.")];
    const ctx = assembleContext({ name: "sliding-window" }, SYSTEM, h, CURRENT, 500);
    expect(ctx.parts.join("\n")).toContain("zoné-λ");
  });
});

describe("full-history", () => {
  test("keeps everything regardless of budget", () => {
    const h = history(30);
    const ctx = assembleContext({ name: "full-history" }, SYSTEM, h, CURRENT, 10);
    expect(ctx.keptTurns).toEqual(h);
    expect(ctx.overBudget).toBe(false);
  });
});

describe("sliding-window", () => {
  test("keeps a contiguous suffix of whole turns, newest preferred", () => {
    const h = history(20);
    const ctx = assembleContext({ name: "sliding-window" }, SYSTEM, h, CURRENT, 200);
    expect(ctx.keptTurns.length).toBeGreaterThan(0);
    expect(ctx.keptTurns.length).toBeLessThan(20);
    expect(ctx.keptTurns).toEqual(h.slice(h.length - ctx.keptTurns.length));
  });

  test("an oversized newest turn blocks the whole window (contiguity, not gaps)", () => {
    const h = [turn("user", "small early turn."), turn("assistant", "x".repeat(2000))];
    const ctx = assembleContext({ name: "sliding-window" }, SYSTEM, h, CURRENT, 200);
    expect(ctx.keptTurns).toEqual([]);
  });

  test("single history turn that fits is kept", () => {
    const h = [turn("assistant", "the target is vega-atlas-7.")];
    const ctx = assembleContext({ name: "sliding-window" }, SYSTEM, h, CURRENT, 200);
    expect(ctx.keptTurns).toEqual(h);
  });
});

describe("head-and-tail", () => {
  test("keeps the first headTurns and the newest tail, dropping the middle", () => {
    const h = history(20);
    const ctx = assembleContext({ name: "head-and-tail", headTurns: 4 }, SYSTEM, h, CURRENT, 180);
    expect(ctx.keptTurns.slice(0, 4)).toEqual(h.slice(0, 4));
    const tail = ctx.keptTurns.slice(4);
    expect(tail.length).toBeGreaterThan(0);
    expect(tail).toEqual(h.slice(h.length - tail.length));
    // head + contiguous suffix and fewer turns than history means the middle is gone
    expect(ctx.keptTurns.length).toBeLessThan(h.length);
  });

  test("with a huge budget it keeps everything", () => {
    const h = history(10);
    const ctx = assembleContext({ name: "head-and-tail", headTurns: 4 }, SYSTEM, h, CURRENT, 100000);
    expect(ctx.keptTurns).toEqual(h);
  });
});

describe("summarize-evicted", () => {
  test("while everything fits it behaves exactly like sliding-window", () => {
    const h = history(4);
    const summ = assembleContext({ name: "summarize-evicted", summaryShare: 0.25 }, SYSTEM, h, CURRENT, 100000);
    const slide = assembleContext({ name: "sliding-window" }, SYSTEM, h, CURRENT, 100000);
    expect(summ.parts).toEqual(slide.parts);
    expect(summ.summarySentences).toEqual([]);
  });

  test("once eviction starts, a summary block appears between system and tail", () => {
    const h: Turn[] = [
      turn("assistant", "decision: the rollout target is vega-atlas-7."),
      ...history(30),
    ];
    const ctx = assembleContext(
      { name: "summarize-evicted", summaryShare: 0.5, summarizer: "rarity" },
      SYSTEM,
      h,
      CURRENT,
      300,
    );
    expect(ctx.parts[1]?.startsWith("summary of earlier turns:")).toBe(true);
    expect(ctx.parts.join("\n")).toContain("vega-atlas-7");
    expect(ctx.tokens).toBeLessThanOrEqual(300);
  });

  test("summary sentences come only from evicted turns", () => {
    const h: Turn[] = [
      turn("assistant", "early quark boson lepton decision alpha."),
      ...history(20),
      turn("assistant", "late meson gluon photon decision omega."),
    ];
    const ctx = assembleContext(
      { name: "summarize-evicted", summaryShare: 0.4, summarizer: "rarity" },
      SYSTEM,
      h,
      CURRENT,
      250,
    );
    const keptTexts = ctx.keptTurns.map((t) => t.text).join(" ");
    for (const s of ctx.summarySentences) {
      expect(keptTexts).not.toContain(s);
    }
    // the late turn is recent, so it must be in the tail, not the summary
    expect(keptTexts).toContain("late meson gluon photon");
  });

  test("summaryShare 0 reserves nothing and degenerates to sliding-window", () => {
    const h = history(30);
    const summ = assembleContext({ name: "summarize-evicted", summaryShare: 0 }, SYSTEM, h, CURRENT, 400);
    const slide = assembleContext({ name: "sliding-window" }, SYSTEM, h, CURRENT, 400);
    expect(summ.parts).toEqual(slide.parts);
  });
});
