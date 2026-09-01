/**
 * Score-gated retrieval escalation: the overlap score pricing its own
 * retrieval. A request runs at k1; when the best sentence's score comes
 * back under a trigger, the server retries retrieval at a bigger k2 and
 * serves the answer from the wider context, paying for the wider context
 * (and the suppressed first draft) only on the queries the score flagged.
 *
 * The analysis mirrors the floor sweep's structure. The escalation
 * decision and both passes' answers are pure functions of per-query,
 * per-k facts a floor-0 run captures (best overlap, would-be correctness,
 * gold-doc hit, token counts), so any (trigger, k2) policy row is a
 * projection over two captures — and the live endpoint, configured with
 * the same policy, must reproduce the projected row exactly.
 *
 * Billing on an escalated query is two model calls, not a re-priced one.
 * With a real model the first draft must be generated before anything can
 * score it, so the retry pays the first call in full — input AND the
 * draft's output — then the second call on the wider context. This
 * server knows the score before streaming (the scripted model's score
 * comes from the retrieval stage), but it bills as if it did not, to keep
 * the cost model honest for the production shape.
 */

import { costUsd, estimateTokens } from "../../08-agent-tool-loop/src/messages.js";
import { REFUSAL } from "./model.js";
import type { QueryOutcome } from "./eval.js";

/** Escalate iff the first pass's best overlap is strictly under trigger. */
export interface EscalationPolicy {
  trigger: number;
  k2: number;
}

export const REFUSAL_TOKENS = estimateTokens(REFUSAL);

/**
 * One query's floor- and trigger-independent facts at one fixed k,
 * captured from a floor-0 eval run (every query answered, so the served
 * answer IS the would-be answer and its token count is on the wire).
 */
export interface KCapture {
  queryId: string;
  /** Gold doc among the k retrieved. */
  hit: boolean;
  /** Best sentence's overlap score at this k. */
  bestOverlap: number;
  /** The would-be answer at this k contains the gold sentence. */
  wouldCorrect: boolean;
  tokensInSystem: number;
  tokensInQuestion: number;
  tokensInContext: number;
  /** Output tokens of the would-be answer sentence. */
  tokensOutAnswer: number;
}

export function captureKFacts(outcomes: readonly QueryOutcome[]): KCapture[] {
  return outcomes.map((o) => {
    if (o.served !== "answered") {
      throw new Error(`captureKFacts expects a floor-0 run where every query answers; ${o.queryId} refused`);
    }
    return {
      queryId: o.queryId,
      hit: o.hit,
      bestOverlap: o.bestOverlap,
      wouldCorrect: o.correct,
      tokensInSystem: o.usage.tokensInSystem,
      tokensInQuestion: o.usage.tokensInQuestion,
      tokensInContext: o.usage.tokensInContext,
      tokensOutAnswer: o.usage.tokensOut,
    };
  });
}

/** What one (trigger, k2) policy does to the full golden set. */
export interface PolicyRow {
  trigger: number;
  k2: number;
  queries: number;
  escalated: number;
  /** Escalated queries that flip from wrong-or-refused to correct. */
  helped: number;
  /** Escalated queries that flip from correct to wrong-or-refused. */
  hurt: number;
  answered: number;
  refused: number;
  correct: number;
  answerAccuracy: number;
  /** Served an answer while the gold doc was not in the final context. */
  answeredWithoutGold: number;
  totalTokensIn: number;
  meanTokensIn: number;
  totalCostUsd: number;
}

interface CallOutcome {
  answered: boolean;
  correct: boolean;
  tokensOut: number;
}

/** The served outcome and output bill of one pass at one floor. */
function passOutcome(capture: KCapture, floor: number): CallOutcome {
  const answered = capture.bestOverlap >= floor;
  return {
    answered,
    correct: answered && capture.wouldCorrect,
    tokensOut: answered ? capture.tokensOutAnswer : REFUSAL_TOKENS,
  };
}

function pairCaptures(capK1: readonly KCapture[], capK2: readonly KCapture[]): [KCapture, KCapture][] {
  const byId = new Map(capK2.map((c) => [c.queryId, c]));
  return capK1.map((c1) => {
    const c2 = byId.get(c1.queryId);
    if (c2 === undefined) throw new Error(`no k2 capture for ${c1.queryId}`);
    return [c1, c2];
  });
}

/**
 * A policy row computed offline from the two captures: escalate iff the
 * k1 score sits under the trigger, bill the first call (with its
 * suppressed draft) plus the second, and read the final outcome off the
 * k2 capture under the same refusal floor.
 */
export function projectPolicyRow(
  capK1: readonly KCapture[],
  capK2: readonly KCapture[],
  floor: number,
  policy: EscalationPolicy,
): PolicyRow {
  return accumulateRow(capK1, capK2, floor, policy, (c1) => c1.bestOverlap < policy.trigger);
}

/**
 * The unreachable best case: escalate exactly the queries escalation
 * turns correct, and no others. Prices the gap between what the trigger
 * can see (a low score) and what it would need to know (why the score is
 * low). `trigger` is NaN in the returned row: no threshold produces it.
 */
export function oracleRow(capK1: readonly KCapture[], capK2: readonly KCapture[], floor: number, k2: number): PolicyRow {
  return accumulateRow(capK1, capK2, floor, { trigger: NaN, k2 }, (c1, c2) => {
    const first = passOutcome(c1, floor);
    const second = passOutcome(c2, floor);
    return !first.correct && second.correct;
  });
}

function accumulateRow(
  capK1: readonly KCapture[],
  capK2: readonly KCapture[],
  floor: number,
  policy: EscalationPolicy,
  shouldEscalate: (c1: KCapture, c2: KCapture) => boolean,
): PolicyRow {
  let escalated = 0;
  let helped = 0;
  let hurt = 0;
  let answered = 0;
  let correct = 0;
  let answeredWithoutGold = 0;
  let totalTokensIn = 0;
  let totalCostUsd = 0;

  for (const [c1, c2] of pairCaptures(capK1, capK2)) {
    const first = passOutcome(c1, floor);
    const tokensInFirst = c1.tokensInSystem + c1.tokensInQuestion + c1.tokensInContext;
    let final: CallOutcome;
    let finalHit: boolean;
    let tokensIn: number;
    let cost: number;
    if (shouldEscalate(c1, c2)) {
      escalated++;
      const second = passOutcome(c2, floor);
      if (!first.correct && second.correct) helped++;
      if (first.correct && !second.correct) hurt++;
      final = second;
      finalHit = c2.hit;
      const tokensInSecond = c2.tokensInSystem + c2.tokensInQuestion + c2.tokensInContext;
      tokensIn = tokensInFirst + tokensInSecond;
      cost = costUsd(tokensInFirst, first.tokensOut) + costUsd(tokensInSecond, second.tokensOut);
    } else {
      final = first;
      finalHit = c1.hit;
      tokensIn = tokensInFirst;
      cost = costUsd(tokensInFirst, first.tokensOut);
    }
    if (final.answered) answered++;
    if (final.correct) correct++;
    if (final.answered && !finalHit) answeredWithoutGold++;
    totalTokensIn += tokensIn;
    totalCostUsd += cost;
  }

  const n = capK1.length;
  return {
    trigger: policy.trigger,
    k2: policy.k2,
    queries: n,
    escalated,
    helped,
    hurt,
    answered,
    refused: n - answered,
    correct,
    answerAccuracy: n === 0 ? 0 : correct / n,
    answeredWithoutGold,
    totalTokensIn,
    meanTokensIn: n === 0 ? 0 : totalTokensIn / n,
    totalCostUsd,
  };
}

/**
 * The same row read off a live eval run against a server configured with
 * this policy. Which queries escalated, what was served, and the bill all
 * come off the wire; helped/hurt need the k1 would-be outcome, which the
 * live run suppressed on escalated queries, so that one column joins the
 * k1 capture — exactly liveFloorRow's shape.
 */
export function livePolicyRow(
  outcomes: readonly QueryOutcome[],
  capK1: readonly KCapture[],
  floor: number,
  policy: EscalationPolicy,
): PolicyRow {
  const byId = new Map(capK1.map((c) => [c.queryId, c]));
  let escalated = 0;
  let helped = 0;
  let hurt = 0;
  let answered = 0;
  let correct = 0;
  let answeredWithoutGold = 0;
  let totalTokensIn = 0;
  let totalCostUsd = 0;

  for (const o of outcomes) {
    if (o.escalated === undefined) {
      throw new Error(`livePolicyRow needs outcomes from an escalation-configured server; ${o.queryId} has no flag`);
    }
    const c1 = byId.get(o.queryId);
    if (c1 === undefined) throw new Error(`no k1 capture for ${o.queryId}`);
    if (o.escalated) {
      escalated++;
      const firstCorrect = passOutcome(c1, floor).correct;
      if (!firstCorrect && o.correct) helped++;
      if (firstCorrect && !o.correct) hurt++;
    }
    if (o.served === "answered") answered++;
    if (o.correct) correct++;
    if (o.served === "answered" && !o.hit) answeredWithoutGold++;
    totalTokensIn += o.usage.tokensIn;
    totalCostUsd += o.usage.costUsd;
  }

  const n = outcomes.length;
  return {
    trigger: policy.trigger,
    k2: policy.k2,
    queries: n,
    escalated,
    helped,
    hurt,
    answered,
    refused: n - answered,
    correct,
    answerAccuracy: n === 0 ? 0 : correct / n,
    answeredWithoutGold,
    totalTokensIn,
    meanTokensIn: n === 0 ? 0 : totalTokensIn / n,
    totalCostUsd,
  };
}
