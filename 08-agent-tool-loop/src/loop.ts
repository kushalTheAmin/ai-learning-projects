/**
 * The agent loop. One task in, one outcome out, everything bounded: a hard
 * model-call budget, a per-intent cap on validation feedback, and an
 * optional loop guard that kills a task once "the same" invalid call has
 * been emitted guardLimit times. What counts as the same is the policy's
 * guardKey: exact (name, canonical args) identity, or the zod issue
 * signature (paths and codes, not values). The guard only counts invalid
 * emissions; a model legitimately calling the same tool with the same args
 * twice is normal agent behavior and must not trip it.
 */

import { VirtualClock } from "../../06-rate-limiting/src/clock.js";
import type { Rng } from "../../05-token-streaming/src/rng.js";
import { costUsd, historyTokens, messageTokens, type Message } from "./messages.js";
import { invalidArgsGuardKey, unknownToolGuardKey, type GuardKeyKind } from "./guards.js";
import { scriptedModelTurn, type TaskSpec } from "./model.js";
import { availableToolNames, formatIssues, isInvalidResult, type ToolSpec } from "./tools.js";

export interface LoopPolicy {
  name: string;
  /** Hard budget on model calls per task. */
  maxModelCalls: number;
  /** Feed zod errors back to the model instead of failing on first invalid call. */
  validationFeedback: boolean;
  /** Validation-feedback rounds allowed per intent before giving up. */
  maxFeedbackPerIntent: number;
  /** Abort once the guard key of an invalid call repeats guardLimit times. */
  loopGuard: boolean;
  /** How invalid calls are grouped for the guard count. */
  guardKey: GuardKeyKind;
  /** Emissions of one guard key that trigger the abort. */
  guardLimit: number;
  /**
   * Check successful tool results against the tool's resultSchema before
   * they enter the history. An invalid result re-executes the tool up to
   * maxReruns times; still invalid after that fails the task (bad-result).
   * Absent = every result is trusted as-is, the original behavior.
   */
  resultValidation?: { maxReruns: number };
}

export type FailReason =
  | "validation-error"
  | "feedback-exhausted"
  | "loop-detected"
  | "step-budget"
  | "wrong-answer"
  | "bad-result";

export interface TaskOutcome {
  taskId: string;
  policy: string;
  ok: boolean;
  finalAnswer?: string;
  failReason?: FailReason;
  modelCalls: number;
  /** Model calls whose output failed validation (unknown tool or bad args). */
  wastedModelCalls: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  /** Input tokens of each model call in order; sums to tokensIn. */
  inputTokensPerCall: number[];
  /** Output tokens of each model call in order; sums to tokensOut. */
  outputTokensPerCall: number[];
  costUsd: number;
  virtualMs: number;
  /** Tool re-executions forced by an invalid result (result validation only). */
  resultReruns: number;
  /** Results still invalid after the rerun budget; each one fails the task. */
  rejectedResults: number;
}

export const MODEL_LATENCY_BASE_MS = 600;
const MODEL_LATENCY_JITTER_MS = 400;
export const DEFAULT_GUARD_LIMIT = 3;

export async function runTask(
  task: TaskSpec,
  policy: LoopPolicy,
  registry: Map<string, ToolSpec>,
  clock: VirtualClock,
  rng: Rng,
): Promise<TaskOutcome> {
  const startMs = clock.now();
  const history: Message[] = [{ role: "user", text: task.prompt }];
  let modelCalls = 0;
  let wastedModelCalls = 0;
  let toolCalls = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  const inputTokensPerCall: number[] = [];
  const outputTokensPerCall: number[] = [];
  let feedbacksThisIntent = 0;
  let resultReruns = 0;
  let rejectedResults = 0;
  const invalidEmissions = new Map<string, number>();

  const finish = (ok: boolean, extra: Partial<TaskOutcome>): TaskOutcome => ({
    taskId: task.id,
    policy: policy.name,
    ok,
    modelCalls,
    wastedModelCalls,
    toolCalls,
    tokensIn,
    tokensOut,
    inputTokensPerCall,
    outputTokensPerCall,
    costUsd: costUsd(tokensIn, tokensOut),
    virtualMs: clock.now() - startMs,
    resultReruns,
    rejectedResults,
    ...extra,
  });

  while (modelCalls < policy.maxModelCalls) {
    modelCalls++;
    const callInputTokens = historyTokens(history);
    tokensIn += callInputTokens;
    inputTokensPerCall.push(callInputTokens);
    await clock.sleep(MODEL_LATENCY_BASE_MS + Math.floor(rng() * MODEL_LATENCY_JITTER_MS));
    const turn = scriptedModelTurn(task, history);
    const assistantMsg: Message = { role: "assistant", turn };
    const turnOutputTokens = messageTokens(assistantMsg);
    tokensOut += turnOutputTokens;
    outputTokensPerCall.push(turnOutputTokens);
    history.push(assistantMsg);

    if (turn.type === "final") {
      if (turn.answer === task.expectedAnswer) {
        return finish(true, { finalAnswer: turn.answer });
      }
      return finish(false, { finalAnswer: turn.answer, failReason: "wrong-answer" });
    }

    const tool = registry.get(turn.name);
    let problem: string;
    let guardKey: string;
    if (tool === undefined) {
      problem = `unknown tool "${turn.name}"; available tools: ${availableToolNames(registry)}`;
      guardKey = unknownToolGuardKey(policy.guardKey, turn);
    } else {
      const parsed = tool.schema.safeParse(turn.args);
      if (parsed.success) {
        feedbacksThisIntent = 0;
        toolCalls++;
        await clock.sleep(tool.latencyMs);
        let result = await tool.run(turn.args);
        if (policy.resultValidation !== undefined) {
          let rerunsThisCall = 0;
          while (isInvalidResult(tool, result) && rerunsThisCall < policy.resultValidation.maxReruns) {
            rerunsThisCall++;
            resultReruns++;
            await clock.sleep(tool.latencyMs);
            result = await tool.run(turn.args);
          }
          if (isInvalidResult(tool, result)) {
            rejectedResults++;
            return finish(false, { failReason: "bad-result" });
          }
        }
        history.push({ role: "tool", result });
        continue;
      }
      problem = `invalid arguments for "${turn.name}": ${formatIssues(parsed.error)}`;
      guardKey = invalidArgsGuardKey(policy.guardKey, turn, parsed.error);
    }

    wastedModelCalls++;

    if (policy.loopGuard) {
      const count = (invalidEmissions.get(guardKey) ?? 0) + 1;
      invalidEmissions.set(guardKey, count);
      if (count >= policy.guardLimit) {
        return finish(false, { failReason: "loop-detected" });
      }
    }
    if (!policy.validationFeedback) {
      return finish(false, { failReason: "validation-error" });
    }
    if (feedbacksThisIntent >= policy.maxFeedbackPerIntent) {
      return finish(false, { failReason: "feedback-exhausted" });
    }
    feedbacksThisIntent++;
    history.push({ role: "validation_error", text: problem });
  }
  return finish(false, { failReason: "step-budget" });
}

export const POLICIES: LoopPolicy[] = [
  {
    name: "strict",
    maxModelCalls: 20,
    validationFeedback: false,
    maxFeedbackPerIntent: 0,
    loopGuard: false,
    guardKey: "exact",
    guardLimit: DEFAULT_GUARD_LIMIT,
  },
  {
    name: "feedback",
    maxModelCalls: 20,
    validationFeedback: true,
    maxFeedbackPerIntent: 6,
    loopGuard: false,
    guardKey: "exact",
    guardLimit: DEFAULT_GUARD_LIMIT,
  },
  {
    name: "guarded",
    maxModelCalls: 20,
    validationFeedback: true,
    maxFeedbackPerIntent: 6,
    loopGuard: true,
    guardKey: "exact",
    guardLimit: DEFAULT_GUARD_LIMIT,
  },
];

/**
 * The guarded policy with result validation on: reruns 0 rejects an invalid
 * result outright, reruns > 0 gives a flaky upstream that many second
 * chances before failing the task.
 */
export function resultValidationPolicy(maxReruns: number): LoopPolicy {
  const base = POLICIES.find((p) => p.name === "guarded");
  if (base === undefined) throw new Error("guarded policy missing");
  return {
    ...base,
    name: maxReruns === 0 ? "guarded+reject" : `guarded+retry${maxReruns}`,
    resultValidation: { maxReruns },
  };
}

/** The signature-keyed variant of the guarded policy, at a given trip limit. */
export function signatureGuardPolicy(limit: number = DEFAULT_GUARD_LIMIT): LoopPolicy {
  return {
    name: limit === DEFAULT_GUARD_LIMIT ? "guarded-sig" : `guarded-sig-${limit}`,
    maxModelCalls: 20,
    validationFeedback: true,
    maxFeedbackPerIntent: 6,
    loopGuard: true,
    guardKey: "signature",
    guardLimit: limit,
  };
}
