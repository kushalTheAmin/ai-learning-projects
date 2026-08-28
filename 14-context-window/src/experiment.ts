/**
 * Run every conversation through a policy at a budget and measure two things:
 *   - retention: at each probe turn, is the fact's value present in the
 *     assembled request context? (substring check; values are unique nonces)
 *   - cost: input tokens per call and dollars per conversation, priced with
 *     08's rates (input $3/MTok, output $15/MTok on the ~4 chars/token proxy)
 *
 * Every exchange is one model call whose input is the assembled context and
 * whose output is the scripted assistant turn, so cost differences between
 * policies come entirely from what the policy kept.
 */

import { estimateTokens, PRICING } from "../../08-agent-tool-loop/src/messages.js";
import { assembleContext, type PolicyConfig, type Turn } from "./policies.js";
import type { Conversation, FactClass, LagBucket } from "./workload.js";

export interface Rate {
  hits: number;
  total: number;
}

export interface CellResult {
  policy: string;
  budget: number;
  overall: Rate;
  byBucket: Record<LagBucket, Rate>;
  byClass: Record<FactClass, Rate>;
  meanInputTokensPerCall: number;
  maxInputTokensPerCall: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  costPerConversation: number;
  overBudgetCalls: number;
  /** Mean input tokens of the call at selected exchanges, for the growth story. */
  callTokensAtExchange: Map<number, number>;
}

export function rate(r: Rate): number {
  return r.total === 0 ? 0 : r.hits / r.total;
}

const emptyRate = (): Rate => ({ hits: 0, total: 0 });

export function runCell(
  policy: PolicyConfig,
  label: string,
  budget: number,
  conversations: readonly Conversation[],
  trackExchanges: readonly number[] = [],
): CellResult {
  const overall = emptyRate();
  const byBucket: Record<LagBucket, Rate> = { short: emptyRate(), medium: emptyRate(), long: emptyRate() };
  const byClass: Record<FactClass, Rate> = { standalone: emptyRate(), buried: emptyRate() };
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let calls = 0;
  let maxInput = 0;
  let overBudgetCalls = 0;
  const trackSums = new Map<number, number>();
  for (const e of trackExchanges) trackSums.set(e, 0);

  for (const convo of conversations) {
    const probeAt = new Map<number, (typeof convo.facts)[number]>();
    for (const f of convo.facts) probeAt.set(f.probeExchange, f);
    const history: Turn[] = [];
    for (let e = 0; e < convo.exchanges; e++) {
      const userTurn = convo.turns[2 * e] as Turn;
      const assistantTurn = convo.turns[2 * e + 1] as Turn;
      const ctx = assembleContext(policy, convo.system, history, userTurn, budget);
      calls++;
      totalInputTokens += ctx.tokens;
      totalOutputTokens += estimateTokens(assistantTurn.text);
      if (ctx.tokens > maxInput) maxInput = ctx.tokens;
      if (ctx.overBudget) overBudgetCalls++;
      if (trackSums.has(e)) trackSums.set(e, (trackSums.get(e) as number) + ctx.tokens);

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
  }

  const callTokensAtExchange = new Map<number, number>();
  for (const [e, sum] of trackSums) callTokensAtExchange.set(e, sum / conversations.length);
  const totalCost =
    (totalInputTokens / 1_000_000) * PRICING.inputPerMTok + (totalOutputTokens / 1_000_000) * PRICING.outputPerMTok;

  return {
    policy: label,
    budget,
    overall,
    byBucket,
    byClass,
    meanInputTokensPerCall: totalInputTokens / calls,
    maxInputTokensPerCall: maxInput,
    totalInputTokens,
    totalOutputTokens,
    costPerConversation: totalCost / conversations.length,
    overBudgetCalls,
    callTokensAtExchange,
  };
}
