/**
 * Runner for the incremental assembler, mirroring runCell probe for probe so
 * a recompute row and an incremental row are the same measurement with only
 * the summarizer's statefulness changed. One assembler instance per
 * conversation; state never leaks across conversations.
 */

import { estimateTokens, PRICING } from "../../08-agent-tool-loop/src/messages.js";
import { IncrementalAssembler, type IncrementalConfig } from "./incremental.js";
import type { Turn } from "./policies.js";
import type { Rate } from "./experiment.js";
import type { Conversation, FactClass, LagBucket } from "./workload.js";

export interface IncrementalCellResult {
  policy: string;
  budget: number;
  overall: Rate;
  byBucket: Record<LagBucket, Rate>;
  byClass: Record<FactClass, Rate>;
  meanInputTokensPerCall: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  costPerConversation: number;
  overBudgetCalls: number;
  summaryWorkTokens: number;
  compactions: number;
  droppedSentences: number;
  shrinkRepacks: number;
  /** Mean token size of the running summary after each conversation's last call. */
  meanFinalSummaryTokens: number;
}

const emptyRate = (): Rate => ({ hits: 0, total: 0 });

export function runIncrementalCell(
  config: IncrementalConfig,
  label: string,
  budget: number,
  conversations: readonly Conversation[],
): IncrementalCellResult {
  const overall = emptyRate();
  const byBucket: Record<LagBucket, Rate> = { short: emptyRate(), medium: emptyRate(), long: emptyRate() };
  const byClass: Record<FactClass, Rate> = { standalone: emptyRate(), buried: emptyRate() };
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let calls = 0;
  let overBudgetCalls = 0;
  let summaryWorkTokens = 0;
  let compactions = 0;
  let droppedSentences = 0;
  let shrinkRepacks = 0;
  let finalSummaryTokens = 0;

  for (const convo of conversations) {
    const assembler = new IncrementalAssembler(config);
    const probeAt = new Map<number, (typeof convo.facts)[number]>();
    for (const f of convo.facts) probeAt.set(f.probeExchange, f);
    const history: Turn[] = [];
    for (let e = 0; e < convo.exchanges; e++) {
      const userTurn = convo.turns[2 * e] as Turn;
      const assistantTurn = convo.turns[2 * e + 1] as Turn;
      const { ctx, stats } = assembler.assemble(convo.system, history, userTurn, budget);
      calls++;
      totalInputTokens += ctx.tokens;
      totalOutputTokens += estimateTokens(assistantTurn.text);
      if (ctx.overBudget) overBudgetCalls++;
      summaryWorkTokens += stats.workTokens;
      if (stats.compacted) compactions++;
      droppedSentences += stats.droppedSentences;
      if (stats.shrinkRepack) shrinkRepacks++;

      const probe = probeAt.get(e);
      if (probe !== undefined) {
        const contextText = ctx.parts.join("\n");
        const hit = contextText.includes(probe.value) ? 1 : 0;
        overall.hits += hit;
        overall.total++;
        byBucket[probe.bucket].hits += hit;
        byBucket[probe.bucket].total++;
        byClass[probe.cls].hits += hit;
        byClass[probe.cls].total++;
      }
      history.push(userTurn, assistantTurn);
    }
    finalSummaryTokens += assembler.summaryTokens();
  }

  const totalCost =
    (totalInputTokens / 1_000_000) * PRICING.inputPerMTok + (totalOutputTokens / 1_000_000) * PRICING.outputPerMTok;

  return {
    policy: label,
    budget,
    overall,
    byBucket,
    byClass,
    meanInputTokensPerCall: totalInputTokens / calls,
    totalInputTokens,
    totalOutputTokens,
    costPerConversation: totalCost / conversations.length,
    overBudgetCalls,
    summaryWorkTokens,
    compactions,
    droppedSentences,
    shrinkRepacks,
    meanFinalSummaryTokens: finalSummaryTokens / conversations.length,
  };
}
