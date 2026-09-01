/**
 * Runs a traffic replay through one cache configuration and prices it.
 * A miss is a (simulated) model call billed at input = system prompt plus
 * query, output = the intent's authored answer; a hit costs nothing. A
 * served answer is wrong when the entry that produced it came from a
 * different intent than the request — the failure mode exact caches cannot
 * have and semantic caches buy their extra hit rate with.
 */

import { costUsd, estimateTokens } from "../../08-agent-tool-loop/src/messages.js";
import { SemanticCache, type MarginPolicy } from "./cache.js";
import { answerFor, SYSTEM_PROMPT } from "./dataset.js";
import { FEATURIZERS, type Featurizer } from "./features.js";
import { DEFAULT_TRAFFIC, generateTraffic, type TrafficConfig, type TrafficRequest } from "./traffic.js";

export interface ReplayResult {
  label: string;
  threshold: number;
  requests: number;
  llmCalls: number;
  exactHits: number;
  semanticCorrect: number;
  semanticWrong: number;
  /** Wrong answers served per 1000 requests. */
  wrongPer1k: number;
  costUsd: number;
  /** Cost saved vs calling the model on every request, as a fraction. */
  savedVsNoCache: number;
  /** Semantic hits (right or wrong) on requests the typo pass altered. */
  semanticHitsOnTypoed: number;
  /** Serves the margin rule refused; each one became a paid model call. */
  marginRefusals: number;
  /** Refusals whose best entry matched the request intent — right serves given up. */
  refusedRight: number;
  /** Refusals whose best entry was another intent — wrong serves avoided. */
  refusedWrong: number;
}

/** One semantic serve as the margin-0 cache saw it, for the gap study. */
export interface ServeRecord {
  right: boolean;
  similarity: number;
  competitorAll: number | undefined;
  competitorDiffering: number | undefined;
}

function callCost(query: string, answer: string): number {
  const inputTokens = estimateTokens(`${SYSTEM_PROMPT}\nuser: ${query}`);
  const outputTokens = estimateTokens(answer);
  return costUsd(inputTokens, outputTokens);
}

/** What the whole replay costs with no cache at all. */
export function noCacheCost(traffic: readonly TrafficRequest[]): number {
  let total = 0;
  for (const request of traffic) total += callCost(request.text, answerFor(request.intentId));
  return total;
}

/**
 * Replay the traffic through a fresh cache. `threshold: Infinity` disables
 * the semantic layer entirely, leaving the exact-match baseline. A margin
 * policy must run live like this — a refusal turns into a model call and an
 * insert, so the store a margined cache builds diverges from the margin-0
 * store, and no offline projection over a margin-0 capture can price it.
 * `onServe` observes each semantic serve (margin-0 runs only, for the gap
 * study).
 */
export function runReplay(
  traffic: readonly TrafficRequest[],
  featurizer: Featurizer,
  threshold: number,
  label: string,
  marginPolicy?: MarginPolicy,
  onServe?: (record: ServeRecord) => void,
): ReplayResult {
  const cache = new SemanticCache(featurizer, threshold, marginPolicy);
  const result: ReplayResult = {
    label,
    threshold,
    requests: traffic.length,
    llmCalls: 0,
    exactHits: 0,
    semanticCorrect: 0,
    semanticWrong: 0,
    wrongPer1k: 0,
    costUsd: 0,
    savedVsNoCache: 0,
    semanticHitsOnTypoed: 0,
    marginRefusals: 0,
    refusedRight: 0,
    refusedWrong: 0,
  };
  for (const request of traffic) {
    const decision = cache.lookup(request.text);
    if (decision.kind === "exact") {
      result.exactHits++;
      continue;
    }
    if (decision.kind === "semantic") {
      const right = decision.entry.intentId === request.intentId;
      if (right) result.semanticCorrect++;
      else result.semanticWrong++;
      if (request.typoed) result.semanticHitsOnTypoed++;
      if (onServe !== undefined) {
        onServe({
          right,
          similarity: decision.similarity,
          competitorAll: decision.competitorAll,
          competitorDiffering: decision.competitorDiffering,
        });
      }
      continue;
    }
    if (decision.kind === "margin-refused") {
      result.marginRefusals++;
      if (decision.entry.intentId === request.intentId) result.refusedRight++;
      else result.refusedWrong++;
    }
    const answer = answerFor(request.intentId);
    result.llmCalls++;
    result.costUsd += callCost(request.text, answer);
    cache.insert(request.text, answer, request.intentId);
  }
  const baseline = noCacheCost(traffic);
  result.wrongPer1k = traffic.length === 0 ? 0 : (result.semanticWrong / traffic.length) * 1000;
  result.savedVsNoCache = baseline === 0 ? 0 : 1 - result.costUsd / baseline;
  return result;
}

/** One (featurizer, threshold, optional margin) operating point, run across many seeds. */
export interface SpreadConfig {
  featurizer: Featurizer;
  threshold: number;
  marginPolicy?: MarginPolicy;
  /** Row label; defaults to the featurizer name. */
  label?: string;
}

export interface SeedSpread {
  label: string;
  threshold: number;
  /** Wrong serves on each seed, in SPREAD_SEEDS order. */
  perSeedWrong: number[];
  wrongMin: number;
  wrongMedian: number;
  wrongMax: number;
  wrongMean: number;
  /** How many seeds served no wrong answer at all. */
  zeroWrongSeeds: number;
  savedMin: number;
  savedMax: number;
}

function featurizerNamed(name: string): Featurizer {
  const found = FEATURIZERS.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`unknown featurizer: ${name}`);
  return found;
}

/** The seeds the spread is measured on: the published one plus 19 neighbours. */
export const SPREAD_SEEDS: readonly number[] = Array.from(
  { length: 20 },
  (_, i) => DEFAULT_TRAFFIC.seed + i,
);

/** The operating points the readme quotes decisions off. */
export const SPREAD_CONFIGS: readonly SpreadConfig[] = [
  { featurizer: featurizerNamed("word"), threshold: 0.8 },
  { featurizer: featurizerNamed("word"), threshold: 0.75 },
  { featurizer: featurizerNamed("char"), threshold: 0.75 },
];

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const upper = sorted[mid];
  if (upper === undefined) return 0;
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[mid - 1];
  return lower === undefined ? upper : (lower + upper) / 2;
}

/**
 * The same operating points over fresh traffic draws. One replay prices the
 * cost side well — savings barely move seed to seed — and says almost
 * nothing about the wrong-answer side, which is what this measures.
 */
export function seedSpread(
  base: TrafficConfig,
  seeds: readonly number[],
  configs: readonly SpreadConfig[],
): SeedSpread[] {
  const spreads: SeedSpread[] = configs.map((config) => ({
    label: config.label ?? config.featurizer.name,
    threshold: config.threshold,
    perSeedWrong: [],
    wrongMin: 0,
    wrongMedian: 0,
    wrongMax: 0,
    wrongMean: 0,
    zeroWrongSeeds: 0,
    savedMin: 0,
    savedMax: 0,
  }));
  const savedByConfig: number[][] = configs.map(() => []);
  for (const seed of seeds) {
    const traffic = generateTraffic({ ...base, seed });
    for (let i = 0; i < configs.length; i++) {
      const config = configs[i];
      const spread = spreads[i];
      const saved = savedByConfig[i];
      if (config === undefined || spread === undefined || saved === undefined) continue;
      const result = runReplay(
        traffic,
        config.featurizer,
        config.threshold,
        config.label ?? config.featurizer.name,
        config.marginPolicy,
      );
      spread.perSeedWrong.push(result.semanticWrong);
      saved.push(result.savedVsNoCache);
    }
  }
  for (let i = 0; i < spreads.length; i++) {
    const spread = spreads[i];
    const saved = savedByConfig[i];
    if (spread === undefined || saved === undefined) continue;
    const wrongs = spread.perSeedWrong;
    if (wrongs.length === 0) continue;
    spread.wrongMin = Math.min(...wrongs);
    spread.wrongMax = Math.max(...wrongs);
    spread.wrongMedian = median(wrongs);
    spread.wrongMean = wrongs.reduce((sum, value) => sum + value, 0) / wrongs.length;
    spread.zeroWrongSeeds = wrongs.filter((value) => value === 0).length;
    spread.savedMin = Math.min(...saved);
    spread.savedMax = Math.max(...saved);
  }
  return spreads;
}
