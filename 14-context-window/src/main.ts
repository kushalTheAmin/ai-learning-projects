/**
 * Entry point: generate the conversation set once, then run every policy
 * through a budget sweep and a summary-share sweep, printing retention and
 * cost. All numbers are deterministic from the seeds below.
 */

import { estimateTokens } from "../../08-agent-tool-loop/src/messages.js";
import { rate, runCell, type CellResult } from "./experiment.js";
import { renderTurn, type PolicyConfig } from "./policies.js";
import { generateConversations } from "./workload.js";

const BASE_SEED = 20260828;
const CONVERSATIONS = 20;
const BUDGETS = [400, 800, 1600, 3200];
const TRACK_EXCHANGES = [0, 14, 29];

const pct = (x: number): string => `${(100 * x).toFixed(1)}%`;
const f1 = (x: number): string => x.toFixed(1);

function policyConfigs(): { label: string; config: PolicyConfig }[] {
  return [
    { label: "sliding-window", config: { name: "sliding-window" } },
    { label: "head-and-tail-4", config: { name: "head-and-tail", headTurns: 4 } },
    { label: "summ-luhn-25%", config: { name: "summarize-evicted", summaryShare: 0.25, summarizer: "luhn" } },
    { label: "summ-rarity-25%", config: { name: "summarize-evicted", summaryShare: 0.25, summarizer: "rarity" } },
  ];
}

function printRow(r: CellResult): void {
  const cols = [
    r.policy.padEnd(16),
    String(r.budget).padStart(6),
    pct(rate(r.overall)).padStart(8),
    pct(rate(r.byBucket.short)).padStart(7),
    pct(rate(r.byBucket.medium)).padStart(7),
    pct(rate(r.byBucket.long)).padStart(7),
    pct(rate(r.byClass.standalone)).padStart(11),
    pct(rate(r.byClass.buried)).padStart(7),
    f1(r.meanInputTokensPerCall).padStart(9),
    `$${r.costPerConversation.toFixed(4)}`.padStart(9),
  ];
  console.log(cols.join("  "));
}

function header(): void {
  console.log(
    ["policy".padEnd(16), "budget".padStart(6), "overall".padStart(8), "short".padStart(7), "medium".padStart(7), "long".padStart(7), "standalone".padStart(11), "buried".padStart(7), "in-tok/call".padStart(9), "$/conv".padStart(9)].join("  "),
  );
}

function main(): void {
  const conversations = generateConversations(BASE_SEED, CONVERSATIONS);
  const turnTokens = conversations.flatMap((c) => c.turns.map((t) => estimateTokens(renderTurn(t))));
  const totalTurnTokens = turnTokens.reduce((a, b) => a + b, 0);
  const probes = conversations.reduce((n, c) => n + c.facts.length, 0);

  console.log("=== corpus ===");
  console.log(`conversations: ${conversations.length}, exchanges each: ${conversations[0]?.exchanges}, probes total: ${probes}`);
  console.log(`mean tokens per turn: ${f1(totalTurnTokens / turnTokens.length)}`);

  console.log("\n=== budget sweep: retention by probe lag and fact class, cost per conversation ===");
  header();
  const full = runCell({ name: "full-history" }, "full-history", Number.MAX_SAFE_INTEGER, conversations, TRACK_EXCHANGES);
  printRow({ ...full, budget: 0 });
  const cells: CellResult[] = [];
  for (const budget of BUDGETS) {
    for (const { label, config } of policyConfigs()) {
      const cell = runCell(config, label, budget, conversations, TRACK_EXCHANGES);
      cells.push(cell);
      printRow(cell);
    }
  }
  console.log("(full-history row shows budget 0 meaning: no budget applied)");
  const anyOverBudget = cells.reduce((n, c) => n + c.overBudgetCalls, 0);
  console.log(`over-budget calls across all cells: ${anyOverBudget}`);

  console.log("\n=== input tokens of the call at exchange 1 / 15 / 30 (mean over conversations) ===");
  const sliding800 = runCell({ name: "sliding-window" }, "sliding-window", 800, conversations, TRACK_EXCHANGES);
  for (const r of [full, sliding800]) {
    const at = (e: number): string => f1(r.callTokensAtExchange.get(e) ?? NaN);
    console.log(`${r.policy.padEnd(16)} ${at(0).padStart(8)} ${at(14).padStart(8)} ${at(29).padStart(8)}`);
  }
  console.log("full-history grows with the conversation; a budgeted policy is flat, so per-call cost is bounded.");

  console.log("\n=== summary share sweep at budget 800 (summarize-evicted, both scorers) ===");
  header();
  for (const summarizer of ["luhn", "rarity"] as const) {
    for (const share of [0.1, 0.25, 0.5]) {
      const cell = runCell(
        { name: "summarize-evicted", summaryShare: share, summarizer },
        `${summarizer}-${Math.round(share * 100)}%`,
        800,
        conversations,
      );
      printRow(cell);
    }
  }
  console.log("the share knob trades recent turns for summary space; what the summary holds depends on the scorer.");
}

main();
