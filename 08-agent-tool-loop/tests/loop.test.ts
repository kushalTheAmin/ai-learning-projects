import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VirtualClock } from "../../06-rate-limiting/src/clock.js";
import { createRng } from "../../05-token-streaming/src/rng.js";
import { POLICIES, runTask, type LoopPolicy, type TaskOutcome } from "../src/loop.js";
import { buildRegistry } from "../src/tools.js";
import { loadCities, loadNotes, loadTasks } from "../src/tasks.js";
import type { TaskSpec } from "../src/model.js";

const dataDir = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const cities = loadCities(join(dataDir, "cities.json"));
const notes = loadNotes(join(dataDir, "notes.json"));
const tasks = loadTasks(join(dataDir, "tasks.json"));

function findTask(id: string): TaskSpec {
  const t = tasks.find((x) => x.id === id);
  if (t === undefined) throw new Error(`no task ${id}`);
  return t;
}

function policy(name: string): LoopPolicy {
  const p = POLICIES.find((x) => x.name === name);
  if (p === undefined) throw new Error(`no policy ${name}`);
  return p;
}

async function run(task: TaskSpec, pol: LoopPolicy, seed = 1): Promise<TaskOutcome> {
  const clock = new VirtualClock();
  const rng = createRng(seed);
  const registry = buildRegistry({
    clock,
    rng,
    cities,
    notes,
    fetchTransientFailures: task.fetchTransientFailures,
  });
  return clock.runUntil(runTask(task, pol, registry, clock, rng));
}

describe("clean tasks", () => {
  it("completes a single-tool task in two model calls", async () => {
    const o = await run(findTask("calc-add"), policy("strict"));
    expect(o.ok).toBe(true);
    expect(o.finalAnswer).toBe("result: 42");
    expect(o.modelCalls).toBe(2);
    expect(o.toolCalls).toBe(1);
    expect(o.wastedModelCalls).toBe(0);
  });

  it("chains tool results across intents", async () => {
    const o = await run(findTask("calc-chain"), policy("strict"));
    expect(o.ok).toBe(true);
    expect(o.finalAnswer).toBe("result: 50");
    expect(o.toolCalls).toBe(2);
  });

  it("handles a task that needs no tools at all", async () => {
    const o = await run(findTask("no-tools"), policy("strict"));
    expect(o.ok).toBe(true);
    expect(o.modelCalls).toBe(1);
    expect(o.toolCalls).toBe(0);
  });

  it("does not trip the loop guard on legitimate duplicate valid calls", async () => {
    const o = await run(findTask("dup-calls"), policy("guarded"));
    expect(o.ok).toBe(true);
    expect(o.failReason).toBeUndefined();
    expect(o.toolCalls).toBe(2);
  });

  it("virtual time advances with model latency and tool latency", async () => {
    const o = await run(findTask("calc-add"), policy("strict"));
    // two model calls at >= 600ms each plus 5ms of tool latency
    expect(o.virtualMs).toBeGreaterThanOrEqual(1205);
  });
});

describe("strict policy", () => {
  it("fails on the first malformed call and wastes exactly one model call", async () => {
    const o = await run(findTask("wrong-type-calc"), policy("strict"));
    expect(o.ok).toBe(false);
    expect(o.failReason).toBe("validation-error");
    expect(o.modelCalls).toBe(1);
    expect(o.wastedModelCalls).toBe(1);
    expect(o.toolCalls).toBe(0);
  });

  it("fails on an unknown tool name", async () => {
    const o = await run(findTask("unknown-tool-calculator"), policy("strict"));
    expect(o.ok).toBe(false);
    expect(o.failReason).toBe("validation-error");
  });
});

describe("feedback policy", () => {
  it("recovers a wrong-type call after one feedback round", async () => {
    const o = await run(findTask("wrong-type-calc"), policy("feedback"));
    expect(o.ok).toBe(true);
    // flawed call + corrected call + final
    expect(o.modelCalls).toBe(3);
    expect(o.wastedModelCalls).toBe(1);
  });

  it("recovers an unknown-tool call after the feedback names the available tools", async () => {
    const o = await run(findTask("unknown-tool-web-search"), policy("feedback"));
    expect(o.ok).toBe(true);
    expect(o.finalAnswer).toBe("result: minhash shingles");
  });

  it("recovers a flaw in the middle of a chain", async () => {
    const o = await run(findTask("chain-mid-flaw"), policy("feedback"));
    expect(o.ok).toBe(true);
    expect(o.finalAnswer).toBe("result: 42");
    expect(o.toolCalls).toBe(2);
    expect(o.wastedModelCalls).toBe(1);
  });

  it("gives up on a stubborn model only after exhausting the feedback budget", async () => {
    const o = await run(findTask("stubborn-wrong-type"), policy("feedback"));
    expect(o.ok).toBe(false);
    expect(o.failReason).toBe("feedback-exhausted");
    // 1 first emission + maxFeedbackPerIntent re-emissions, all wasted
    expect(o.modelCalls).toBe(1 + policy("feedback").maxFeedbackPerIntent);
    expect(o.wastedModelCalls).toBe(o.modelCalls);
  });

  it("completes the slow corrector that needs three feedback rounds", async () => {
    const o = await run(findTask("slow-corrector"), policy("feedback"));
    expect(o.ok).toBe(true);
    expect(o.modelCalls).toBe(5);
    expect(o.wastedModelCalls).toBe(3);
  });
});

describe("guarded policy", () => {
  it("aborts a stubborn model at the third identical invalid call", async () => {
    const o = await run(findTask("stubborn-wrong-type"), policy("guarded"));
    expect(o.ok).toBe(false);
    expect(o.failReason).toBe("loop-detected");
    expect(o.modelCalls).toBe(3);
    expect(o.wastedModelCalls).toBe(3);
  });

  it("kills the slow corrector the feedback policy would have saved", async () => {
    const o = await run(findTask("slow-corrector"), policy("guarded"));
    expect(o.ok).toBe(false);
    expect(o.failReason).toBe("loop-detected");
    expect(o.modelCalls).toBe(3);
  });

  it("still recovers ordinary one-round corrections", async () => {
    const o = await run(findTask("missing-field-lookup"), policy("guarded"));
    expect(o.ok).toBe(true);
    expect(o.finalAnswer).toBe("result: 22620000");
  });
});

describe("feedback budget is per intent, not per task", () => {
  it("a second flawed intent gets a fresh feedback budget after a successful dispatch", async () => {
    const oneRound: LoopPolicy = { ...policy("feedback"), name: "one-round", maxFeedbackPerIntent: 1 };
    const twoFlaws: TaskSpec = {
      id: "two-flaws",
      prompt: "add 1 and 2, then add 3 and 4",
      intents: [
        {
          call: { type: "tool_call", name: "calc", args: { op: "add", a: 1, b: 2 } },
          flawKind: "wrong-type",
          flawedCall: { type: "tool_call", name: "calc", args: { op: "add", a: "1", b: 2 } },
          correctsAfter: 1,
        },
        {
          call: { type: "tool_call", name: "calc", args: { op: "add", a: 3, b: 4 } },
          flawKind: "wrong-type",
          flawedCall: { type: "tool_call", name: "calc", args: { op: "add", a: "3", b: 4 } },
          correctsAfter: 1,
        },
      ],
      finalTemplate: "result: {last}",
      expectedAnswer: "result: 7",
      fetchTransientFailures: 0,
    };
    // each intent needs its single allowed feedback round; if the counter were
    // shared across intents the second flaw would hit feedback-exhausted
    const o = await run(twoFlaws, oneRound);
    expect(o.ok).toBe(true);
    expect(o.finalAnswer).toBe("result: 7");
    expect(o.wastedModelCalls).toBe(2);
  });
});

describe("budgets and evaluation", () => {
  it("fails with step-budget when the model-call budget is too small for the chain", async () => {
    const tiny: LoopPolicy = { ...policy("feedback"), name: "tiny", maxModelCalls: 2 };
    const o = await run(findTask("calc-chain"), tiny);
    expect(o.ok).toBe(false);
    expect(o.failReason).toBe("step-budget");
    expect(o.modelCalls).toBe(2);
  });

  it("marks a reached-but-wrong final answer as wrong-answer", async () => {
    const wrong: TaskSpec = { ...findTask("calc-add"), expectedAnswer: "result: 43" };
    const o = await run(wrong, policy("strict"));
    expect(o.ok).toBe(false);
    expect(o.failReason).toBe("wrong-answer");
    expect(o.finalAnswer).toBe("result: 42");
  });

  it("retries transient fetch failures inside a single tool call", async () => {
    const o = await run(findTask("fetch-flaky-4"), policy("strict"));
    expect(o.ok).toBe(true);
    expect(o.finalAnswer).toBe("result: fetched https://example.com/very-flaky status=200 attempts=5");
    expect(o.toolCalls).toBe(1);
  });

  it("accounts tokens and cost monotonically with conversation growth", async () => {
    const short = await run(findTask("calc-add"), policy("feedback"));
    const long = await run(findTask("wrong-type-calc"), policy("feedback"));
    expect(long.tokensIn).toBeGreaterThan(short.tokensIn);
    expect(long.costUsd).toBeGreaterThan(short.costUsd);
  });

  it("is deterministic for a fixed seed", async () => {
    const a = await run(findTask("fetch-flaky-2"), policy("guarded"), 42);
    const b = await run(findTask("fetch-flaky-2"), policy("guarded"), 42);
    expect(a).toEqual(b);
  });
});
