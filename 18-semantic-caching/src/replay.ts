/**
 * Runs a traffic replay through one cache configuration and prices it.
 * A miss is a (simulated) model call billed at input = system prompt plus
 * query, output = the intent's authored answer; a hit costs nothing. A
 * served answer is wrong when the entry that produced it came from a
 * different intent than the request — the failure mode exact caches cannot
 * have and semantic caches buy their extra hit rate with.
 */

import { costUsd, estimateTokens } from "../../08-agent-tool-loop/src/messages.js";
import { SemanticCache } from "./cache.js";
import { answerFor, SYSTEM_PROMPT } from "./dataset.js";
import type { Featurizer } from "./features.js";
import type { TrafficRequest } from "./traffic.js";

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
 * the semantic layer entirely, leaving the exact-match baseline.
 */
export function runReplay(
  traffic: readonly TrafficRequest[],
  featurizer: Featurizer,
  threshold: number,
  label: string,
): ReplayResult {
  const cache = new SemanticCache(featurizer, threshold);
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
  };
  for (const request of traffic) {
    const decision = cache.lookup(request.text);
    if (decision.kind === "exact") {
      result.exactHits++;
      continue;
    }
    if (decision.kind === "semantic") {
      if (decision.entry.intentId === request.intentId) result.semanticCorrect++;
      else result.semanticWrong++;
      if (request.typoed) result.semanticHitsOnTypoed++;
      continue;
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
