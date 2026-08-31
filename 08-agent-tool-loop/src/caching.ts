/**
 * Prompt-cache pricing over the per-call input traces the loop records.
 * The loop itself is untouched: caching changes what a replayed token
 * costs, not what the model does, so every completion count and call
 * count in the main experiment stays exactly as published.
 *
 * Cache model: the history is append-only and a breakpoint sits at the end
 * of every request's input, so call n reads call n-1's entire input from
 * cache and writes only its own new suffix. Calls within a task sit
 * seconds apart on the virtual clock, far inside any real ttl, so every
 * intra-task read hits. Nothing is shared across tasks (each task starts a
 * fresh conversation). Under that model the write bill telescopes: total
 * tokens written per task equals the final call's input size.
 */

import type { TaskOutcome } from "./loop.js";
import { isStubborn, type TaskSpec } from "./model.js";
import { PRICING, type Pricing } from "./messages.js";
import type { ExperimentReport } from "./experiment.js";

export interface CacheRates {
  /** Cache-read price as a multiple of the fresh input price. */
  readMult: number;
  /** Cache-write price as a multiple of the fresh input price. */
  writeMult: number;
}

/** Anthropic's published multipliers: reads at 0.1x, 5m-ttl writes at 1.25x. */
export const ANTHROPIC_RATES: CacheRates = { readMult: 0.1, writeMult: 1.25 };

/** readMult=writeMult=1 must reproduce the uncached bill exactly. */
export const UNCACHED_RATES: CacheRates = { readMult: 1, writeMult: 1 };

export interface CachedBill {
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  /** Input bill folded to fresh-token equivalents: write*writeMult + read*readMult. */
  effectiveInputTokens: number;
  inputCostUsd: number;
  outputCostUsd: number;
  costUsd: number;
}

export function priceTrace(
  inputTokensPerCall: readonly number[],
  outputTokens: number,
  rates: CacheRates,
  pricing: Pricing = PRICING,
): CachedBill {
  let read = 0;
  let write = 0;
  let prev = 0;
  for (const tokens of inputTokensPerCall) {
    if (tokens < prev) {
      throw new Error(`input trace shrank ${prev} -> ${tokens}; history must be append-only`);
    }
    read += prev;
    write += tokens - prev;
    prev = tokens;
  }
  const effectiveInputTokens = write * rates.writeMult + read * rates.readMult;
  const inputCostUsd = (effectiveInputTokens * pricing.inputPerMTok) / 1_000_000;
  const outputCostUsd = (outputTokens * pricing.outputPerMTok) / 1_000_000;
  return {
    cacheReadTokens: read,
    cacheWriteTokens: write,
    outputTokens,
    effectiveInputTokens,
    inputCostUsd,
    outputCostUsd,
    costUsd: inputCostUsd + outputCostUsd,
  };
}

export function priceOutcomes(outcomes: readonly TaskOutcome[], rates: CacheRates): CachedBill {
  const total: CachedBill = {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    effectiveInputTokens: 0,
    inputCostUsd: 0,
    outputCostUsd: 0,
    costUsd: 0,
  };
  for (const o of outcomes) {
    const bill = priceTrace(o.inputTokensPerCall, o.tokensOut, rates);
    total.cacheReadTokens += bill.cacheReadTokens;
    total.cacheWriteTokens += bill.cacheWriteTokens;
    total.outputTokens += bill.outputTokens;
    total.effectiveInputTokens += bill.effectiveInputTokens;
    total.inputCostUsd += bill.inputCostUsd;
    total.outputCostUsd += bill.outputCostUsd;
    total.costUsd += bill.costUsd;
  }
  return total;
}

export interface PolicyCachingRow {
  policy: string;
  tokensIn: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  effectiveInputTokens: number;
  uncachedCostUsd: number;
  cachedCostUsd: number;
  /** Share of the whole uncached bill (input and output) that caching removes. */
  cachingSavedPct: number;
}

export interface StubbornPricingRow {
  label: string;
  feedbackCostUsd: number;
  guardedCostUsd: number;
  guardSavedUsd: number;
  guardSavedPct: number;
}

export interface SweepRow {
  readMult: number;
  writeMult: number;
  feedbackCostUsd: number;
  guardedCostUsd: number;
  guardSavedPct: number;
}

export interface StubbornComposition {
  policy: string;
  readUsd: number;
  writeUsd: number;
  outputUsd: number;
}

export interface CachingReport {
  perPolicy: PolicyCachingRow[];
  stubbornTasks: number;
  /** The published token-based figure, recomputed: guard tokens saved / feedback tokens. */
  stubbornTokensSavedPct: number;
  stubborn: StubbornPricingRow[];
  stubbornComposition: StubbornComposition[];
  sweep: SweepRow[];
}

const SWEEP_READ_MULTS = [0, 0.05, 0.1, 0.25, 0.5, 1];

function stubbornOutcomes(
  report: ExperimentReport,
  tasks: readonly TaskSpec[],
  policy: string,
): TaskOutcome[] {
  const row = report.perPolicy.find((p) => p.policy === policy);
  if (row === undefined) throw new Error(`policy ${policy} missing from report`);
  return tasks.flatMap((task, i) => (isStubborn(task) ? [row.outcomes[i]!] : []));
}

export function computeCachingReport(
  report: ExperimentReport,
  tasks: readonly TaskSpec[],
): CachingReport {
  const perPolicy: PolicyCachingRow[] = report.perPolicy.map((p) => {
    const cached = priceOutcomes(p.outcomes, ANTHROPIC_RATES);
    const uncached = priceOutcomes(p.outcomes, UNCACHED_RATES);
    return {
      policy: p.policy,
      tokensIn: p.tokensIn,
      cacheReadTokens: cached.cacheReadTokens,
      cacheWriteTokens: cached.cacheWriteTokens,
      effectiveInputTokens: cached.effectiveInputTokens,
      uncachedCostUsd: uncached.costUsd,
      cachedCostUsd: cached.costUsd,
      cachingSavedPct: (100 * (uncached.costUsd - cached.costUsd)) / uncached.costUsd,
    };
  });

  const feedback = stubbornOutcomes(report, tasks, "feedback");
  const guarded = stubbornOutcomes(report, tasks, "guarded");

  const tokens = (outcomes: TaskOutcome[]): number =>
    outcomes.reduce((acc, o) => acc + o.tokensIn + o.tokensOut, 0);
  const feedbackTokens = tokens(feedback);
  const stubbornTokensSavedPct = (100 * (feedbackTokens - tokens(guarded))) / feedbackTokens;

  const pricingRow = (label: string, rates: CacheRates): StubbornPricingRow => {
    const f = priceOutcomes(feedback, rates).costUsd;
    const g = priceOutcomes(guarded, rates).costUsd;
    return {
      label,
      feedbackCostUsd: f,
      guardedCostUsd: g,
      guardSavedUsd: f - g,
      guardSavedPct: (100 * (f - g)) / f,
    };
  };

  const composition = (policy: string, outcomes: TaskOutcome[]): StubbornComposition => {
    const bill = priceOutcomes(outcomes, ANTHROPIC_RATES);
    return {
      policy,
      readUsd:
        (bill.cacheReadTokens * ANTHROPIC_RATES.readMult * PRICING.inputPerMTok) / 1_000_000,
      writeUsd:
        (bill.cacheWriteTokens * ANTHROPIC_RATES.writeMult * PRICING.inputPerMTok) / 1_000_000,
      outputUsd: bill.outputCostUsd,
    };
  };

  const sweep: SweepRow[] = SWEEP_READ_MULTS.map((readMult) => {
    const rates: CacheRates = { readMult, writeMult: ANTHROPIC_RATES.writeMult };
    const row = pricingRow(`read ${readMult}x`, rates);
    return {
      readMult,
      writeMult: rates.writeMult,
      feedbackCostUsd: row.feedbackCostUsd,
      guardedCostUsd: row.guardedCostUsd,
      guardSavedPct: row.guardSavedPct,
    };
  });

  return {
    perPolicy,
    stubbornTasks: feedback.length,
    stubbornTokensSavedPct,
    stubborn: [
      pricingRow("uncached", UNCACHED_RATES),
      pricingRow("cached 0.1x/1.25x", ANTHROPIC_RATES),
    ],
    stubbornComposition: [composition("feedback", feedback), composition("guarded", guarded)],
    sweep,
  };
}
