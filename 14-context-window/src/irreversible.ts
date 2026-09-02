/**
 * Entry point for the irreversibility study: the stateless summarize-evicted
 * policy (re-summarizes all evicted turns every call, can resurrect anything)
 * against the incremental running summary (folds turns once, can never
 * revisit what it discarded). Same conversations, same probes, same budgets;
 * the only variable is whether the summarizer keeps state.
 *
 * work/conv is the token bill of what the scorer re-reads per conversation —
 * the cost axis on which incremental summarization earns its keep.
 * All numbers are deterministic from the seeds below.
 */

import { rate, runCell, type CellResult } from "./experiment.js";
import { runIncrementalCell, type IncrementalCellResult } from "./irreversibility.js";
import { generateConversations } from "./workload.js";

const BASE_SEED = 20260828;
const CONVERSATIONS = 20;
const STANDARD = { exchanges: 30, factCount: 12 };
const LONG = { exchanges: 60, factCount: 12 };
const SCORERS = ["luhn", "rarity"] as const;

const pct = (x: number): string => `${(100 * x).toFixed(1)}%`;
const f0 = (x: number): string => x.toFixed(0);
const f1 = (x: number): string => x.toFixed(1);

interface Row {
  label: string;
  budget: number;
  overall: number;
  short: number;
  medium: number;
  long: number;
  workPerConv: number;
  compactionsPerConv: number;
  droppedPerConv: number | null;
  finalSummaryTokens: number | null;
}

function fromRecompute(r: CellResult, convCount: number): Row {
  return {
    label: r.policy,
    budget: r.budget,
    overall: rate(r.overall),
    short: rate(r.byBucket.short),
    medium: rate(r.byBucket.medium),
    long: rate(r.byBucket.long),
    workPerConv: r.summaryWorkTokens / convCount,
    compactionsPerConv: r.compactions / convCount,
    droppedPerConv: null,
    finalSummaryTokens: null,
  };
}

function fromIncremental(r: IncrementalCellResult, convCount: number): Row {
  return {
    label: r.policy,
    budget: r.budget,
    overall: rate(r.overall),
    short: rate(r.byBucket.short),
    medium: rate(r.byBucket.medium),
    long: rate(r.byBucket.long),
    workPerConv: r.summaryWorkTokens / convCount,
    compactionsPerConv: r.compactions / convCount,
    droppedPerConv: r.droppedSentences / convCount,
    finalSummaryTokens: r.meanFinalSummaryTokens,
  };
}

function header(): void {
  console.log(
    [
      "policy".padEnd(18),
      "budget".padStart(6),
      "overall".padStart(8),
      "short".padStart(7),
      "medium".padStart(7),
      "long".padStart(7),
      "work/conv".padStart(10),
      "cmp/conv".padStart(9),
      "drop/conv".padStart(10),
      "sum-tok".padStart(8),
    ].join("  "),
  );
}

function printRow(r: Row): void {
  console.log(
    [
      r.label.padEnd(18),
      String(r.budget).padStart(6),
      pct(r.overall).padStart(8),
      pct(r.short).padStart(7),
      pct(r.medium).padStart(7),
      pct(r.long).padStart(7),
      f0(r.workPerConv).padStart(10),
      f1(r.compactionsPerConv).padStart(9),
      (r.droppedPerConv === null ? "-" : f1(r.droppedPerConv)).padStart(10),
      (r.finalSummaryTokens === null ? "-" : f1(r.finalSummaryTokens)).padStart(8),
    ].join("  "),
  );
}

function pair(
  conversations: ReturnType<typeof generateConversations>,
  scorer: (typeof SCORERS)[number],
  share: number,
  budget: number,
): { recompute: Row; incremental: Row; gapPoints: number; workRatio: number } {
  const shareLabel = `${Math.round(share * 100)}%`;
  const rec = runCell(
    { name: "summarize-evicted", summaryShare: share, summarizer: scorer },
    `recompute-${scorer}-${shareLabel}`,
    budget,
    conversations,
  );
  const inc = runIncrementalCell(
    { summaryShare: share, summarizer: scorer },
    `increm-${scorer}-${shareLabel}`,
    budget,
    conversations,
  );
  const recompute = fromRecompute(rec, conversations.length);
  const incremental = fromIncremental(inc, conversations.length);
  return {
    recompute,
    incremental,
    gapPoints: 100 * (recompute.overall - incremental.overall),
    workRatio: recompute.workPerConv / incremental.workPerConv,
  };
}

function runRegime(
  title: string,
  conversations: ReturnType<typeof generateConversations>,
  budgets: readonly number[],
  share: number,
): void {
  console.log(`\n=== ${title}: recompute vs incremental at summary share ${Math.round(share * 100)}% ===`);
  header();
  const gaps: string[] = [];
  for (const scorer of SCORERS) {
    for (const budget of budgets) {
      const { recompute, incremental, gapPoints, workRatio } = pair(conversations, scorer, share, budget);
      printRow(recompute);
      printRow(incremental);
      gaps.push(
        `${scorer}@${budget}: retention gap ${gapPoints.toFixed(1)} points, recompute re-reads ${workRatio.toFixed(1)}x the tokens`,
      );
    }
  }
  console.log("gaps (recompute minus incremental):");
  for (const g of gaps) console.log(`  ${g}`);
}

function main(): void {
  const standard = generateConversations(BASE_SEED, CONVERSATIONS, STANDARD);
  const long = generateConversations(BASE_SEED + 1_000_003, CONVERSATIONS, LONG);
  for (const [name, convos] of [
    ["standard", standard],
    ["long", long],
  ] as const) {
    const probes = convos.reduce((n, c) => n + c.facts.length, 0);
    console.log(
      `${name} regime: ${convos.length} conversations x ${convos[0]?.exchanges} exchanges, ${probes} probes`,
    );
  }

  runRegime("standard regime (30 exchanges)", standard, [400, 800, 1600], 0.25);
  runRegime("long regime (60 exchanges)", long, [400, 800, 1600], 0.25);

  console.log("\n=== long regime, share sweep at budget 800 ===");
  header();
  for (const scorer of SCORERS) {
    for (const share of [0.1, 0.25, 0.5]) {
      const { recompute, incremental } = pair(long, scorer, share, 800);
      printRow(recompute);
      printRow(incremental);
    }
  }
  console.log(
    "\nsum-tok is the running summary's size after the last call; a value well under the",
    "\nshare's budget means the packer, not the budget, is doing the discarding.",
  );
}

main();
