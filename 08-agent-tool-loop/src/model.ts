/**
 * The scripted model. Every task carries an intent list: the tool calls a
 * competent model would make, in order, each optionally wrapped in an
 * authored flaw (the malformed call it emits first) and a correction rule
 * (how many validation-feedback rounds it takes to emit the correct call;
 * null means it never does). The model is a pure function of the visible
 * conversation: intents advance on tool results, corrections count
 * validation-error messages since the last tool result. That makes every
 * run replayable and lets the same task be scored under different loop
 * policies without the model changing underneath.
 */

import type { AssistantTurn, Message, ToolCallTurn } from "./messages.js";

export type FlawKind = "none" | "wrong-type" | "missing-field" | "extra-field" | "unknown-tool";

export interface Intent {
  /** The correct call. */
  call: ToolCallTurn;
  flawKind: FlawKind;
  /** The malformed call emitted while flawed; required when flawKind != "none". */
  flawedCall?: ToolCallTurn;
  /**
   * Malformed calls emitted on later feedback rounds while still flawed:
   * round r > 0 emits flawDrift[r - 1], clamped to the last entry once the
   * authored variants run out. Absent = the model repeats flawedCall
   * verbatim, the original stubborn shape.
   */
  flawDrift?: ToolCallTurn[];
  /** Validation-feedback rounds before the correct call appears; null = never. */
  correctsAfter: number | null;
}

export interface TaskSpec {
  id: string;
  prompt: string;
  intents: Intent[];
  /** Final answer template; "{last}" is replaced by the last successful tool value. */
  finalTemplate: string;
  expectedAnswer: string;
  /** fetch_page transport attempts that 503 before succeeding. */
  fetchTransientFailures: number;
}

export function scriptedModelTurn(task: TaskSpec, history: readonly Message[]): AssistantTurn {
  let completed = 0;
  let feedbackSinceResult = 0;
  let lastValue: string | undefined;
  for (const msg of history) {
    if (msg.role === "tool") {
      completed++;
      feedbackSinceResult = 0;
      if (msg.result.ok && msg.result.value !== undefined) lastValue = msg.result.value;
    } else if (msg.role === "validation_error") {
      feedbackSinceResult++;
    }
  }

  const intent = task.intents[completed];
  if (intent === undefined) {
    const answer = task.finalTemplate.replace("{last}", lastValue ?? "(no result)");
    return { type: "final", answer };
  }

  if (intent.flawKind !== "none") {
    if (intent.flawedCall === undefined) {
      throw new Error(`task ${task.id}: intent has flawKind ${intent.flawKind} but no flawedCall`);
    }
    const stillFlawed = intent.correctsAfter === null || feedbackSinceResult < intent.correctsAfter;
    if (stillFlawed) {
      if (intent.flawDrift !== undefined && intent.flawDrift.length > 0 && feedbackSinceResult > 0) {
        const idx = Math.min(feedbackSinceResult - 1, intent.flawDrift.length - 1);
        return intent.flawDrift[idx]!;
      }
      return intent.flawedCall;
    }
  }
  return intent.call;
}

/** The same task with every flaw stripped: what a clean run would have cost. */
export function cleanTwin(task: TaskSpec): TaskSpec {
  return {
    ...task,
    id: `${task.id}(clean)`,
    intents: task.intents.map((intent) => ({
      call: intent.call,
      flawKind: "none",
      correctsAfter: 0,
    })),
  };
}

export function taskFlawKinds(task: TaskSpec): FlawKind[] {
  return task.intents.filter((i) => i.flawKind !== "none").map((i) => i.flawKind);
}

export function isStubborn(task: TaskSpec): boolean {
  return task.intents.some((i) => i.flawKind !== "none" && i.correctsAfter === null);
}
