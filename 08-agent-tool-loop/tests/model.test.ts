import { describe, expect, it } from "vitest";
import { cleanTwin, isStubborn, scriptedModelTurn, taskFlawKinds, type TaskSpec } from "../src/model.js";
import type { Message } from "../src/messages.js";

function task(overrides: Partial<TaskSpec>): TaskSpec {
  return {
    id: "t",
    prompt: "p",
    intents: [],
    finalTemplate: "result: {last}",
    expectedAnswer: "result: 42",
    fetchTransientFailures: 0,
    ...overrides,
  };
}

const flawedTask = task({
  intents: [
    {
      call: { type: "tool_call", name: "calc", args: { op: "add", a: 19, b: 23 } },
      flawKind: "wrong-type",
      flawedCall: { type: "tool_call", name: "calc", args: { op: "add", a: "19", b: 23 } },
      correctsAfter: 1,
    },
  ],
});

const user: Message = { role: "user", text: "p" };

describe("scriptedModelTurn", () => {
  it("answers immediately when there are no intents", () => {
    const turn = scriptedModelTurn(task({ finalTemplate: "hello" }), [user]);
    expect(turn).toEqual({ type: "final", answer: "hello" });
  });

  it("uses (no result) when the template wants a value nothing produced", () => {
    const turn = scriptedModelTurn(task({}), [user]);
    expect(turn).toEqual({ type: "final", answer: "result: (no result)" });
  });

  it("emits the flawed call before any feedback", () => {
    const turn = scriptedModelTurn(flawedTask, [user]);
    expect(turn).toEqual({ type: "tool_call", name: "calc", args: { op: "add", a: "19", b: 23 } });
  });

  it("emits the correct call once enough feedback has arrived", () => {
    const history: Message[] = [
      user,
      { role: "assistant", turn: { type: "tool_call", name: "calc", args: { op: "add", a: "19", b: 23 } } },
      { role: "validation_error", text: "a: expected number" },
    ];
    const turn = scriptedModelTurn(flawedTask, history);
    expect(turn).toEqual({ type: "tool_call", name: "calc", args: { op: "add", a: 19, b: 23 } });
  });

  it("never corrects when correctsAfter is null", () => {
    const stubborn = task({
      intents: [{ ...flawedTask.intents[0]!, correctsAfter: null }],
    });
    const history: Message[] = [user];
    for (let i = 0; i < 5; i++) history.push({ role: "validation_error", text: "still wrong" });
    const turn = scriptedModelTurn(stubborn, history);
    expect(turn).toEqual({ type: "tool_call", name: "calc", args: { op: "add", a: "19", b: 23 } });
  });

  it("advances to the next intent on a tool result and resets the feedback count", () => {
    const twoIntents = task({
      intents: [
        {
          call: { type: "tool_call", name: "search_notes", args: { query: "bucket" } },
          flawKind: "none",
          correctsAfter: 0,
        },
        flawedTask.intents[0]!,
      ],
    });
    const afterFirst: Message[] = [
      user,
      { role: "assistant", turn: twoIntents.intents[0]!.call },
      { role: "tool", result: { ok: true, value: "token bucket" } },
    ];
    // second intent starts flawed again even though feedback was never seen for it
    expect(scriptedModelTurn(twoIntents, afterFirst)).toEqual(flawedTask.intents[0]!.flawedCall);
  });

  it("templates the final answer from the last successful tool value", () => {
    const history: Message[] = [
      user,
      { role: "assistant", turn: flawedTask.intents[0]!.call },
      { role: "tool", result: { ok: true, value: "42" } },
    ];
    expect(scriptedModelTurn(flawedTask, history)).toEqual({ type: "final", answer: "result: 42" });
  });

  it("is a pure function of the history", () => {
    const history: Message[] = [user];
    expect(scriptedModelTurn(flawedTask, history)).toEqual(scriptedModelTurn(flawedTask, history));
  });
});

describe("cleanTwin", () => {
  it("strips flaws but keeps the correct calls and the expected answer", () => {
    const twin = cleanTwin(flawedTask);
    expect(twin.intents).toEqual([
      { call: flawedTask.intents[0]!.call, flawKind: "none", correctsAfter: 0 },
    ]);
    expect(twin.expectedAnswer).toBe(flawedTask.expectedAnswer);
    expect(twin.id).toBe("t(clean)");
  });
});

describe("task classification", () => {
  it("collects flaw kinds and detects stubbornness", () => {
    expect(taskFlawKinds(flawedTask)).toEqual(["wrong-type"]);
    expect(isStubborn(flawedTask)).toBe(false);
    const stubborn = task({ intents: [{ ...flawedTask.intents[0]!, correctsAfter: null }] });
    expect(isStubborn(stubborn)).toBe(true);
  });
});
