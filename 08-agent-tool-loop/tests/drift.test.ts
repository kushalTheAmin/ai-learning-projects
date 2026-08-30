import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { VirtualClock } from "../../06-rate-limiting/src/clock.js";
import { createRng } from "../../05-token-streaming/src/rng.js";
import { driftCategory, runDriftStudy, type DriftStudyInputs } from "../src/driftStudy.js";
import { exactGuardKey, issueSignature, unknownToolGuardKey } from "../src/guards.js";
import {
  POLICIES,
  runTask,
  signatureGuardPolicy,
  type LoopPolicy,
  type TaskOutcome,
} from "../src/loop.js";
import type { Message } from "../src/messages.js";
import { cleanTwin, scriptedModelTurn, type TaskSpec } from "../src/model.js";
import { buildRegistry } from "../src/tools.js";
import { loadCities, loadNotes, loadTasks } from "../src/tasks.js";

const dataDir = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const cities = loadCities(join(dataDir, "cities.json"));
const notes = loadNotes(join(dataDir, "notes.json"));
const driftTasks = loadTasks(join(dataDir, "driftTasks.json"));
const originalTasks = loadTasks(join(dataDir, "tasks.json"));

const calcSchema = z.strictObject({
  op: z.enum(["add", "sub", "mul", "div"]),
  a: z.number().finite(),
  b: z.number().finite(),
});

function issuesOf(args: unknown): z.ZodError {
  const parsed = calcSchema.safeParse(args);
  if (parsed.success) throw new Error("expected a validation failure");
  return parsed.error;
}

function findTask(id: string): TaskSpec {
  const t = driftTasks.find((x) => x.id === id);
  if (t === undefined) throw new Error(`no drift task ${id}`);
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

describe("issue signatures", () => {
  it("collapses value drift on one field into one signature", () => {
    const a = issueSignature("calc", issuesOf({ op: "plus", a: 1, b: 2 }));
    const b = issueSignature("calc", issuesOf({ op: "sum", a: 9, b: 8 }));
    expect(a).toBe(b);
  });

  it("separates failures on different paths", () => {
    const missingB = issueSignature("calc", issuesOf({ op: "add", a: 1 }));
    const wrongA = issueSignature("calc", issuesOf({ op: "add", a: "one", b: 2 }));
    expect(missingB).not.toBe(wrongA);
  });

  it("separates a two-issue failure from either single-issue failure", () => {
    const both = issueSignature("calc", issuesOf({ op: "add", a: "one" }));
    const missingB = issueSignature("calc", issuesOf({ op: "add", a: 1 }));
    const wrongA = issueSignature("calc", issuesOf({ op: "add", a: "one", b: 2 }));
    expect(both).not.toBe(missingB);
    expect(both).not.toBe(wrongA);
    expect(both).toContain("a:");
    expect(both).toContain("b:");
  });

  it("ignores which unrecognized keys were invented", () => {
    const schema = z.strictObject({ query: z.string() });
    const sigOf = (args: unknown) => {
      const parsed = schema.safeParse(args);
      if (parsed.success) throw new Error("expected failure");
      return issueSignature("search_notes", parsed.error);
    };
    expect(sigOf({ query: "x", max: 5 })).toBe(sigOf({ query: "x", count: 9 }));
  });

  it("includes the tool name so two tools with the same broken path stay apart", () => {
    const calcSig = issueSignature("calc", issuesOf({ op: "plus", a: 1, b: 2 }));
    const otherSig = issueSignature("other", issuesOf({ op: "plus", a: 1, b: 2 }));
    expect(calcSig).not.toBe(otherSig);
  });

  it("keys unknown tools by name only under the signature kind", () => {
    const a = unknownToolGuardKey("signature", { type: "tool_call", name: "calculator", args: { x: 1 } });
    const b = unknownToolGuardKey("signature", { type: "tool_call", name: "calculator", args: { y: 2 } });
    expect(a).toBe(b);
    const exactA = unknownToolGuardKey("exact", { type: "tool_call", name: "calculator", args: { x: 1 } });
    const exactB = unknownToolGuardKey("exact", { type: "tool_call", name: "calculator", args: { y: 2 } });
    expect(exactA).not.toBe(exactB);
  });

  it("exact keys distinguish drifted values", () => {
    const a = exactGuardKey({ type: "tool_call", name: "calc", args: { op: "plus", a: 1, b: 2 } });
    const b = exactGuardKey({ type: "tool_call", name: "calc", args: { op: "sum", a: 1, b: 2 } });
    expect(a).not.toBe(b);
  });
});

describe("drifting scripted model", () => {
  it("emits flawedCall first, then walks the drift sequence, clamping at the end", () => {
    const task = findTask("value-drift-calc-op");
    const history = (feedbacks: number) => {
      const msgs: Message[] = [{ role: "user", text: task.prompt }];
      for (let i = 0; i < feedbacks; i++) msgs.push({ role: "validation_error", text: "nope" });
      return msgs;
    };
    const opAt = (feedbacks: number): unknown => {
      const turn = scriptedModelTurn(task, history(feedbacks));
      if (turn.type !== "tool_call") throw new Error("expected a tool call");
      return (turn.args as Record<string, unknown>).op;
    };
    expect(opAt(0)).toBe("plus");
    expect(opAt(1)).toBe("sum");
    expect(opAt(6)).toBe("join");
    // past the authored variants the model repeats the last one
    expect(opAt(7)).toBe("join");
    expect(opAt(20)).toBe("join");
  });

  it("cleanTwin strips the drift sequence along with the flaw", () => {
    const twin = cleanTwin(findTask("value-drift-calc-op"));
    expect(twin.intents.every((i) => i.flawDrift === undefined && i.flawedCall === undefined)).toBe(
      true,
    );
  });
});

describe("drift task file", () => {
  it("loads 10 tasks and every id carries a known category prefix", () => {
    expect(driftTasks).toHaveLength(10);
    for (const task of driftTasks) expect(() => driftCategory(task)).not.toThrow();
  });

  it("rejects a drift sequence on a clean intent", () => {
    const bad = [
      {
        id: "bad-clean-drift",
        prompt: "x",
        intents: [
          {
            call: { name: "calc", args: { op: "add", a: 1, b: 2 } },
            flawKind: "none",
            flawDrift: [{ name: "calc", args: { op: "plus", a: 1, b: 2 } }],
            correctsAfter: 0,
          },
        ],
        finalTemplate: "result: {last}",
        expectedAnswer: "result: 3",
        fetchTransientFailures: 0,
      },
    ];
    const dir = mkdtempSync(join(tmpdir(), "drift-schema-"));
    const path = join(dir, "bad.json");
    writeFileSync(path, JSON.stringify(bad));
    try {
      expect(() => loadTasks(path)).toThrow(/flawDrift/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("every drifted emission in the stubborn value-drift tasks is distinct", () => {
    for (const id of ["value-drift-calc-op", "value-drift-city-number", "value-drift-url"]) {
      const intent = findTask(id).intents[0]!;
      const emissions = [intent.flawedCall!, ...(intent.flawDrift ?? [])];
      const keys = new Set(emissions.map((e) => exactGuardKey(e)));
      expect(keys.size).toBe(emissions.length);
    }
  });
});

describe("guards against drifting invalid calls", () => {
  it("the exact guard never trips on value drift: burns the whole feedback budget", async () => {
    const o = await run(findTask("value-drift-calc-op"), policy("guarded"));
    expect(o.ok).toBe(false);
    expect(o.failReason).toBe("feedback-exhausted");
    expect(o.modelCalls).toBe(1 + policy("guarded").maxFeedbackPerIntent);
  });

  it("the signature guard aborts value drift at the third same-signature emission", async () => {
    const o = await run(findTask("value-drift-calc-op"), signatureGuardPolicy());
    expect(o.ok).toBe(false);
    expect(o.failReason).toBe("loop-detected");
    expect(o.modelCalls).toBe(3);
  });

  it("the signature guard catches invented extra keys even when the key name drifts", async () => {
    const o = await run(findTask("extrakey-drift-search"), signatureGuardPolicy());
    expect(o.failReason).toBe("loop-detected");
    expect(o.modelCalls).toBe(3);
  });

  it("alternating two broken shapes delays the signature guard to the fifth emission", async () => {
    const exact = await run(findTask("shape-drift-alternate"), policy("guarded"));
    expect(exact.failReason).toBe("feedback-exhausted");
    expect(exact.modelCalls).toBe(7);
    const sig = await run(findTask("shape-drift-alternate"), signatureGuardPolicy());
    expect(sig.failReason).toBe("loop-detected");
    expect(sig.modelCalls).toBe(5);
  });

  it("rotating three broken shapes walks past the signature guard until the budget ends anyway", async () => {
    const sig = await run(findTask("shape-drift-rotate3"), signatureGuardPolicy());
    expect(sig.ok).toBe(false);
    expect(sig.modelCalls).toBe(7);
  });

  it("kills the same-signature slow corrector the exact guard would have saved", async () => {
    const exact = await run(findTask("slow-sig-corrector-calc"), policy("guarded"));
    expect(exact.ok).toBe(true);
    expect(exact.finalAnswer).toBe("result: 42");
    const sig = await run(findTask("slow-sig-corrector-calc"), signatureGuardPolicy());
    expect(sig.ok).toBe(false);
    expect(sig.failReason).toBe("loop-detected");
    expect(sig.modelCalls).toBe(3);
  });

  it("a limit-4 signature guard spares the slow corrector", async () => {
    const o = await run(findTask("slow-sig-corrector-calc"), signatureGuardPolicy(4));
    expect(o.ok).toBe(true);
    expect(o.finalAnswer).toBe("result: 42");
  });

  it("does not trip on a corrector whose signature shrinks as it fixes issues", async () => {
    for (const id of ["progressive-two-issues", "progressive-unknown-tool"]) {
      const o = await run(findTask(id), signatureGuardPolicy());
      expect(o.ok).toBe(true);
      expect(o.finalAnswer).toBe("result: 42");
    }
  });
});

describe("drift study", () => {
  const inputs: DriftStudyInputs = { tasks: driftTasks, originalTasks, cities, notes };

  it("completions: feedback and exact guard tie, signature guard trades completions for burn", async () => {
    const r = await runDriftStudy(inputs);
    const row = (name: string) => {
      const p = r.perPolicy.find((x) => x.policy === name);
      if (p === undefined) throw new Error(`no aggregate for ${name}`);
      return p;
    };
    expect(row("feedback").completed).toBe(4);
    expect(row("guarded").completed).toBe(4);
    expect(row("guarded-sig").completed).toBe(2);
    // exact guard is byte-identical to no guard on this suite
    expect(row("guarded").tokensIn).toBe(row("feedback").tokensIn);
    expect(row("guarded").tokensOut).toBe(row("feedback").tokensOut);
  });

  it("stubborn drift burn: exact guard saves nothing, signature guard saves more than half", async () => {
    const r = await runDriftStudy(inputs);
    const burn = (name: string) => {
      const row = r.stubbornDrift.find((x) => x.policy === name);
      if (row === undefined) throw new Error(`no burn row for ${name}`);
      return row;
    };
    expect(r.stubbornTasks).toBe(6);
    expect(burn("guarded").savedTokensPct).toBe(0);
    expect(burn("guarded-sig").savedTokensPct).toBeGreaterThan(50);
    expect(burn("guarded-sig").tokens).toBeLessThan(burn("feedback").tokens);
  });

  it("names exactly the two slow correctors as the signature guard's kills", async () => {
    const r = await runDriftStudy(inputs);
    expect(r.killedCorrectors["guarded"]).toEqual([]);
    expect(r.killedCorrectors["guarded-sig"]).toEqual([
      "slow-sig-corrector-calc",
      "slow-sig-corrector-city",
    ]);
  });

  it("limit sweep: limit 4 restores every corrector while still capping stubborn burn", async () => {
    const r = await runDriftStudy(inputs);
    const at = (limit: number) => {
      const row = r.sweep.find((x) => x.limit === limit);
      if (row === undefined) throw new Error(`no sweep row for limit ${limit}`);
      return row;
    };
    expect(at(3).completed).toBe(2);
    expect(at(3).correctorsKilled).toBe(2);
    expect(at(4).completed).toBe(4);
    expect(at(4).correctorsKilled).toBe(0);
    const feedbackStubborn = r.stubbornDrift.find((x) => x.policy === "feedback")!;
    expect(at(4).stubbornTokens).toBeLessThan(feedbackStubborn.tokens);
    // stubborn burn grows monotonically with the limit
    for (let i = 1; i < r.sweep.length; i++) {
      expect(r.sweep[i]!.stubbornTokens).toBeGreaterThan(r.sweep[i - 1]!.stubbornTokens);
    }
  });

  it("on the original 25 tasks the signature guard changes nothing", async () => {
    const r = await runDriftStudy(inputs);
    expect(r.originalSuite.tasks).toBe(25);
    expect(r.originalSuite.guardedCompleted).toBe(r.originalSuite.sigCompleted);
    expect(r.originalSuite.divergingTaskIds).toEqual([]);
  });

  it("is deterministic across runs", async () => {
    const a = await runDriftStudy(inputs);
    const b = await runDriftStudy(inputs);
    expect(a).toEqual(b);
  });
});
