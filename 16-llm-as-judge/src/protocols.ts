/**
 * Presentation-order protocols over a pair set, with per-call token and cost
 * accounting. as-stored presents slot a first every time (the dataset's
 * arrangement is the protocol's input), randomized flips a seeded coin per
 * pair, both-order runs each pair twice and abstains when the two calls
 * disagree about the same underlying answer.
 */

import { costUsd, estimateTokens } from "../../08-agent-tool-loop/src/messages.js";
import type { Pair, Slot } from "./dataset.js";
import { judgePair, type JudgeSpec } from "./judge.js";
import { streamFor } from "./rand.js";

export type PairProtocol = "as-stored" | "randomized" | "both-order";

export const PAIR_RUBRIC =
  "You are comparing two answers to the same question. Pick the answer a " +
  "careful engineer would rather receive: correct, complete, and actionable. " +
  "Reply with exactly one token, FIRST or SECOND.";

export const GRADE_RUBRIC =
  "You are grading one answer against the question. PASS means a careful " +
  "engineer could act on it as written; FAIL means it is wrong, incomplete, " +
  "or misleading. Reply with exactly one token, PASS or FAIL.";

/** Fixed output size of a verdict reply. */
export const VERDICT_TOKENS = 8;

export interface CallCost {
  calls: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export interface PairVerdict {
  pairId: string;
  /** Canonical winner, or abstain when both-order calls disagree. */
  verdict: Slot | "abstain";
  /** both-order only: did the two orders name different winners? */
  flipped: boolean;
}

export interface ProtocolRun {
  judge: string;
  protocol: PairProtocol;
  verdicts: PairVerdict[];
  cost: CallCost;
}

export function pairCallTokens(pair: Pair): number {
  return estimateTokens(
    `${PAIR_RUBRIC}\n${pair.question}\n${pair.a.text}\n${pair.b.text}`,
  );
}

export function gradeCallTokens(question: string, answerText: string): number {
  return estimateTokens(`${GRADE_RUBRIC}\n${question}\n${answerText}`);
}

function emptyCost(): CallCost {
  return { calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 };
}

function addCall(cost: CallCost, tokensIn: number): void {
  cost.calls += 1;
  cost.tokensIn += tokensIn;
  cost.tokensOut += VERDICT_TOKENS;
  cost.costUsd = costUsd(cost.tokensIn, cost.tokensOut);
}

/** Seeded presentation order for the randomized protocol: a property of the
 * run, shared by every judge, the way one harness randomizes once per item. */
export function randomizedFirstSlot(pairId: string, seed: number): Slot {
  return streamFor(`order|${pairId}|${seed}`)() < 0.5 ? "a" : "b";
}

export function runPairs(
  judge: JudgeSpec,
  pairs: readonly Pair[],
  protocol: PairProtocol,
  seed: number,
): ProtocolRun {
  const verdicts: PairVerdict[] = [];
  const cost = emptyCost();
  for (const pair of pairs) {
    const tokens = pairCallTokens(pair);
    if (protocol === "both-order") {
      const forward = judgePair(judge, pair, "a");
      const reverse = judgePair(judge, pair, "b");
      addCall(cost, tokens);
      addCall(cost, tokens);
      const flipped = forward !== reverse;
      verdicts.push({ pairId: pair.id, verdict: flipped ? "abstain" : forward, flipped });
    } else {
      const firstSlot: Slot =
        protocol === "as-stored" ? "a" : randomizedFirstSlot(pair.id, seed);
      addCall(cost, tokens);
      verdicts.push({
        pairId: pair.id,
        verdict: judgePair(judge, pair, firstSlot),
        flipped: false,
      });
    }
  }
  return { judge: judge.name, protocol, verdicts, cost };
}
