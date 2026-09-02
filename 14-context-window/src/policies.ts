/**
 * Context assembly under a token budget.
 *
 * Every policy is a pure function of (system, history, currentUser, budget):
 * nothing carries state between turns. That matters for the summarize policy,
 * which re-summarizes the evicted turns from scratch on every call — a real
 * incremental summarizer can never recover a sentence an earlier compression
 * already discarded, so the numbers here are an upper bound for extractive
 * summarization at a given budget, not an estimate of a running-summary
 * implementation.
 *
 * Token accounting: context tokens are the sum of estimateTokens over each
 * rendered part (system line, summary block, each turn line), so fitting
 * decisions and the reported number use the same arithmetic.
 */

import { estimateTokens } from "../../08-agent-tool-loop/src/messages.js";
import { luhnScorer, rarityScorer, summarize } from "./salience.js";
import { sentences } from "./text.js";

export type Role = "user" | "assistant";

export interface Turn {
  role: Role;
  text: string;
}

export type PolicyName = "full-history" | "sliding-window" | "head-and-tail" | "summarize-evicted";

export interface PolicyConfig {
  name: PolicyName;
  /** head-and-tail only: number of oldest turns pinned after the system prompt. */
  headTurns?: number;
  /** summarize-evicted only: fraction of the budget reserved for the summary block. */
  summaryShare?: number;
  /** summarize-evicted only: which salience definition ranks evicted sentences. */
  summarizer?: "luhn" | "rarity";
}

export interface AssembledContext {
  /** Rendered parts in order: system, optional summary block, turn lines, current user line. */
  parts: string[];
  /** Sum of estimateTokens over parts. */
  tokens: number;
  /** True when the pinned parts alone (system + current user turn) exceed the budget. */
  overBudget: boolean;
  /** History turns that made it into the context, oldest first. */
  keptTurns: Turn[];
  /** Sentences of evicted turns that survived into the summary block (summarize-evicted only). */
  summarySentences: string[];
  /**
   * Tokens of the sentences handed to the salience scorer on this call, set
   * only on calls where a summary was (re)built. For summarize-evicted that
   * pool is every evicted sentence, every time — the re-read bill an
   * incremental summarizer exists to avoid.
   */
  summaryWorkTokens?: number;
}

export function renderTurn(turn: Turn): string {
  return `${turn.role}: ${turn.text}`;
}

export const SUMMARY_HEADER = "summary of earlier turns:";

function baseParts(system: string, currentUser: Turn): { parts: string[]; tokens: number } {
  const parts = [system, renderTurn(currentUser)];
  return { parts, tokens: parts.reduce((n, p) => n + estimateTokens(p), 0) };
}

/** Newest-first greedy fill: keep whole recent turns while they fit. */
export function fillTail(history: readonly Turn[], room: number): { kept: Turn[]; used: number } {
  const kept: Turn[] = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const cost = estimateTokens(renderTurn(history[i] as Turn));
    if (used + cost > room) break;
    kept.push(history[i] as Turn);
    used += cost;
  }
  kept.reverse();
  return { kept, used };
}

export function finish(system: string, summaryBlock: string | null, kept: Turn[], currentUser: Turn, overBudget: boolean, summarySentences: string[]): AssembledContext {
  const parts: string[] = [system];
  if (summaryBlock !== null) parts.push(summaryBlock);
  for (const t of kept) parts.push(renderTurn(t));
  parts.push(renderTurn(currentUser));
  const tokens = parts.reduce((n, p) => n + estimateTokens(p), 0);
  return { parts, tokens, overBudget, keptTurns: kept, summarySentences };
}

/**
 * Assemble the request context for the current user turn. The system prompt
 * and the current user turn are always included, budget or not; when they
 * alone blow the budget, overBudget is set and no history is kept.
 */
export function assembleContext(
  config: PolicyConfig,
  system: string,
  history: readonly Turn[],
  currentUser: Turn,
  budget: number,
): AssembledContext {
  const base = baseParts(system, currentUser);
  if (config.name === "full-history") {
    return finish(system, null, [...history], currentUser, false, []);
  }
  if (base.tokens > budget) {
    return finish(system, null, [], currentUser, true, []);
  }
  const room = budget - base.tokens;

  if (config.name === "sliding-window") {
    const { kept } = fillTail(history, room);
    return finish(system, null, kept, currentUser, false, []);
  }

  if (config.name === "head-and-tail") {
    const headTurns = config.headTurns ?? 4;
    const head: Turn[] = [];
    let headUsed = 0;
    for (const t of history.slice(0, headTurns)) {
      const cost = estimateTokens(renderTurn(t));
      if (headUsed + cost > room) break;
      head.push(t);
      headUsed += cost;
    }
    const rest = history.slice(head.length);
    const { kept: tail } = fillTail(rest, room - headUsed);
    return finish(system, null, [...head, ...tail], currentUser, false, []);
  }

  // summarize-evicted: reserve a share of the room for the summary block,
  // but only once something actually has to be evicted — while the whole
  // history still fits, behave exactly like sliding-window.
  const share = config.summaryShare ?? 0.25;
  const summaryBudget = Math.floor(room * share);
  const headerCost = estimateTokens(SUMMARY_HEADER);
  const fullFit = fillTail(history, room);
  if (fullFit.kept.length === history.length) {
    return finish(system, null, fullFit.kept, currentUser, false, []);
  }
  const { kept } = fillTail(history, room - summaryBudget);
  const evicted = history.slice(0, history.length - kept.length);
  let summaryBlock: string | null = null;
  let summarySentences: string[] = [];
  let workTokens: number | undefined;
  if (evicted.length > 0 && summaryBudget > headerCost) {
    const evictedSentences = evicted.flatMap((t) => sentences(t.text));
    const scorer = (config.summarizer ?? "luhn") === "luhn" ? luhnScorer() : rarityScorer();
    workTokens = evictedSentences.reduce((n, s) => n + estimateTokens(s), 0);
    summarySentences = summarize(evictedSentences, summaryBudget - headerCost, scorer);
    if (summarySentences.length > 0) {
      summaryBlock = `${SUMMARY_HEADER} ${summarySentences.join(" ")}`;
    }
  }
  const ctx = finish(system, summaryBlock, kept, currentUser, false, summarySentences);
  if (workTokens !== undefined) ctx.summaryWorkTokens = workTokens;
  return ctx;
}
