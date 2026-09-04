import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VirtualClock } from "../../06-rate-limiting/src/clock.js";
import { createRng } from "../../05-token-streaming/src/rng.js";
import { resultValidationPolicy, runTask, type LoopPolicy, type TaskOutcome } from "../src/loop.js";
import { substituteArgs } from "../src/model.js";
import { buildRegistry, isInvalidResult } from "../src/tools.js";
import { loadCities, loadNotes } from "../src/tasks.js";
import {
  BOMB_CHARS,
  GARBAGE_VALUE,
  corruptRegistry,
  corruptValue,
  findRow,
  loadResultTasks,
  runResultStudy,
  resultStudyPolicies,
  type ResultTask,
} from "../src/resultStudy.js";
import { renderResultReport } from "../src/report.js";

const dataDir = join(dirname(fileURLToPath(import.meta.url)), "..", "data");

function writeTmp(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "result-tasks-"));
  const path = join(dir, "tasks.json");
  writeFileSync(path, JSON.stringify(content));
  return path;
}
const cities = loadCities(join(dataDir, "cities.json"));
const notes = loadNotes(join(dataDir, "notes.json"));
const resultTasks = loadResultTasks(join(dataDir, "resultTasks.json"));

function findResultTask(id: string): ResultTask {
  const t = resultTasks.find((x) => x.task.id === id);
  if (t === undefined) throw new Error(`no result task ${id}`);
  return t;
}

async function runCorrupted(rt: ResultTask, pol: LoopPolicy, seed = 1): Promise<TaskOutcome> {
  const clock = new VirtualClock();
  const rng = createRng(seed);
  const registry = corruptRegistry(
    buildRegistry({ clock, rng, cities, notes, fetchTransientFailures: 0 }),
    rt.corruption,
  );
  return clock.runUntil(runTask(rt.task, pol, registry, clock, rng));
}

const offPolicy = resultStudyPolicies()[0]!;

describe("substituteArgs", () => {
  const call = { type: "tool_call" as const, name: "calc", args: { a: "{last:number}", b: 2, note: "{last}" } };

  it("replaces both placeholder forms and leaves other args alone", () => {
    const out = substituteArgs(call, "139875");
    expect(out.args).toEqual({ a: 139875, b: 2, note: "139875" });
  });

  it("returns the same object when nothing matches", () => {
    const plain = { type: "tool_call" as const, name: "calc", args: { a: 1, b: 2 } };
    expect(substituteArgs(plain, "5")).toBe(plain);
  });

  it("coerces an empty last value to 0, not to an invalid number", () => {
    const out = substituteArgs(call, "");
    expect(out.args).toEqual({ a: 0, b: 2, note: "" });
  });

  it("coerces garbage to NaN and a missing value to NaN and '(no result)'", () => {
    expect((substituteArgs(call, GARBAGE_VALUE).args as { a: number }).a).toBeNaN();
    const missing = substituteArgs(call, undefined);
    expect((missing.args as { a: number }).a).toBeNaN();
    expect((missing.args as { note: string }).note).toBe("(no result)");
  });

  it("leaves non-record args untouched", () => {
    const weird = { type: "tool_call" as const, name: "calc", args: ["{last}"] };
    expect(substituteArgs(weird, "5")).toBe(weird);
  });
});

describe("corruptValue", () => {
  it("multiplies a numeric lie by 10", () => {
    expect(corruptValue("lie", "139875")).toBe("1398750");
    expect(corruptValue("lie", "-2.5")).toBe("-25");
  });

  it("refuses to lie about non-numeric values", () => {
    expect(() => corruptValue("lie", "retry backoff notes")).toThrow(/numeric/);
    expect(() => corruptValue("lie", "")).toThrow(/numeric/);
  });

  it("produces the fixed empty, garbage, and bomb shapes", () => {
    expect(corruptValue("empty", "x")).toBe("");
    expect(corruptValue("garbage", "x")).toBe(GARBAGE_VALUE);
    expect(corruptValue("bomb", "x")).toHaveLength(BOMB_CHARS);
  });
});

describe("corruptRegistry", () => {
  function freshRegistry() {
    const clock = new VirtualClock();
    return { clock, registry: buildRegistry({ clock, rng: createRng(1), cities, notes, fetchTransientFailures: 0 }) };
  }

  it("throws on a target tool that does not exist", () => {
    const { registry } = freshRegistry();
    expect(() => corruptRegistry(registry, { tool: "nope", family: "garbage" })).toThrow(/unknown tool/);
  });

  it("returns the registry unchanged with no corruption", () => {
    const { registry } = freshRegistry();
    expect(corruptRegistry(registry, undefined)).toBe(registry);
  });

  it("corrupts only the target tool and leaves the rest alone", async () => {
    const { clock, registry } = freshRegistry();
    const corrupted = corruptRegistry(registry, { tool: "lookup_city", family: "garbage" });
    const done = (async () => {
      const bad = await corrupted.get("lookup_city")!.run({ city: "Tokyo" });
      const fine = await corrupted.get("calc")!.run({ op: "add", a: 1, b: 2 });
      return { bad, fine };
    })();
    const { bad, fine } = await clock.runUntil(done);
    expect(bad).toEqual({ ok: true, value: GARBAGE_VALUE });
    expect(fine).toEqual({ ok: true, value: "3" });
  });

  it("keeps persistent garbage across executions but clears transient garbage on the rerun", async () => {
    const { clock, registry } = freshRegistry();
    const persistent = corruptRegistry(registry, { tool: "lookup_city", family: "garbage" });
    const transient = corruptRegistry(registry, { tool: "calc", family: "transient-garbage" });
    const done = (async () => {
      const p1 = await persistent.get("lookup_city")!.run({ city: "Tokyo" });
      const p2 = await persistent.get("lookup_city")!.run({ city: "Tokyo" });
      const t1 = await transient.get("calc")!.run({ op: "add", a: 1, b: 2 });
      const t2 = await transient.get("calc")!.run({ op: "add", a: 1, b: 2 });
      return { p1, p2, t1, t2 };
    })();
    const r = await clock.runUntil(done);
    expect(r.p1.value).toBe(GARBAGE_VALUE);
    expect(r.p2.value).toBe(GARBAGE_VALUE);
    expect(r.t1.value).toBe(GARBAGE_VALUE);
    expect(r.t2.value).toBe("3");
  });

  it("passes tool-reported errors through uncorrupted", async () => {
    const { clock, registry } = freshRegistry();
    const corrupted = corruptRegistry(registry, { tool: "lookup_city", family: "garbage" });
    const result = await clock.runUntil(corrupted.get("lookup_city")!.run({ city: "Atlantis" }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unknown city/);
  });
});

describe("result checkers", () => {
  const clock = new VirtualClock();
  const registry = buildRegistry({ clock, rng: createRng(1), cities, notes, fetchTransientFailures: 0 });
  const tool = (name: string) => registry.get(name)!;

  it("accepts the values the tools actually produce", () => {
    expect(isInvalidResult(tool("lookup_city"), { ok: true, value: "139875" })).toBe(false);
    expect(isInvalidResult(tool("calc"), { ok: true, value: "-2.5" })).toBe(false);
    expect(isInvalidResult(tool("calc"), { ok: true, value: "1e+21" })).toBe(false);
    expect(isInvalidResult(tool("search_notes"), { ok: true, value: "retry backoff notes" })).toBe(false);
    expect(isInvalidResult(tool("fetch_page"), { ok: true, value: "fetched https://x.dev status=200 attempts=1" })).toBe(false);
  });

  it("rejects empty, garbage, and bomb values on the numeric tools", () => {
    expect(isInvalidResult(tool("lookup_city"), { ok: true, value: "" })).toBe(true);
    expect(isInvalidResult(tool("lookup_city"), { ok: true, value: GARBAGE_VALUE })).toBe(true);
    expect(isInvalidResult(tool("lookup_city"), { ok: true, value: "x".repeat(BOMB_CHARS) })).toBe(true);
    expect(isInvalidResult(tool("calc"), { ok: true, value: "" })).toBe(true);
    expect(isInvalidResult(tool("calc"), { ok: true, value: GARBAGE_VALUE })).toBe(true);
    expect(isInvalidResult(tool("calc"), { ok: true, value: "NaN" })).toBe(true);
  });

  it("cannot tell garbage prose from real prose - the documented blind spot", () => {
    expect(isInvalidResult(tool("search_notes"), { ok: true, value: GARBAGE_VALUE })).toBe(false);
  });

  it("never flags tool-reported errors or tools without a result schema", () => {
    expect(isInvalidResult(tool("calc"), { ok: false, error: "division by zero" })).toBe(false);
    const bare = { ...tool("calc") };
    delete bare.resultSchema;
    expect(isInvalidResult(bare, { ok: true, value: GARBAGE_VALUE })).toBe(false);
  });
});

describe("loadResultTasks", () => {
  it("loads the committed dataset with clean intents throughout", () => {
    expect(resultTasks).toHaveLength(11);
    for (const rt of resultTasks) {
      expect(rt.task.intents.every((i) => i.flawKind === "none")).toBe(true);
      expect(rt.task.fetchTransientFailures).toBe(0);
    }
    expect(findResultTask("a-bomb-lookup").corruption).toEqual({ tool: "lookup_city", family: "bomb" });
    expect(findResultTask("a-clean").corruption).toBeUndefined();
  });

  it("rejects a corruption that targets a tool the task never calls", () => {
    expect(() =>
      loadResultTasks(writeTmp([
        {
          id: "x",
          prompt: "p",
          calls: [{ name: "calc", args: {} }],
          finalTemplate: "f {last}",
          expectedAnswer: "f 1",
          corruption: { tool: "lookup_city", family: "garbage" },
        },
      ])),
    ).toThrow(/must target a tool the task calls/);
  });

  it("rejects an unknown corruption family and an empty call list", () => {
    expect(() =>
      loadResultTasks(writeTmp([
        {
          id: "x",
          prompt: "p",
          calls: [{ name: "calc", args: {} }],
          finalTemplate: "f",
          expectedAnswer: "a",
          corruption: { tool: "calc", family: "stale" },
        },
      ])),
    ).toThrow();
    expect(() =>
      loadResultTasks(writeTmp([{ id: "x", prompt: "p", calls: [], finalTemplate: "f", expectedAnswer: "a" }])),
    ).toThrow();
  });
});

describe("the loop under result validation", () => {
  const reject = resultValidationPolicy(0);
  const retry2 = resultValidationPolicy(2);

  it("rescues transient garbage with one rerun under retry2", async () => {
    const o = await runCorrupted(findResultTask("a-transient-lookup"), retry2);
    expect(o.ok).toBe(true);
    expect(o.finalAnswer).toBe("doubled population: 279750");
    expect(o.resultReruns).toBe(1);
    expect(o.rejectedResults).toBe(0);
  });

  it("fails fast on transient garbage under reject (no rerun budget)", async () => {
    const o = await runCorrupted(findResultTask("a-transient-lookup"), reject);
    expect(o.ok).toBe(false);
    expect(o.failReason).toBe("bad-result");
    expect(o.resultReruns).toBe(0);
    expect(o.rejectedResults).toBe(1);
  });

  it("spends the full rerun budget on persistent garbage, then fails", async () => {
    const o = await runCorrupted(findResultTask("a-garbage-lookup"), retry2);
    expect(o.ok).toBe(false);
    expect(o.failReason).toBe("bad-result");
    expect(o.resultReruns).toBe(2);
    expect(o.rejectedResults).toBe(1);
  });

  it("lets a lie through every check and fails only on the answer key", async () => {
    const o = await runCorrupted(findResultTask("a-lie-lookup"), retry2);
    expect(o.ok).toBe(false);
    expect(o.failReason).toBe("wrong-answer");
    expect(o.finalAnswer).toBe("doubled population: 2797500");
    expect(o.resultReruns).toBe(0);
  });

  it("with validation off, garbage becomes NaN args one hop later and the guard kills the task", async () => {
    const o = await runCorrupted(findResultTask("a-garbage-lookup"), offPolicy);
    expect(o.ok).toBe(false);
    expect(o.failReason).toBe("loop-detected");
    expect(o.wastedModelCalls).toBe(3);
    expect(o.resultReruns).toBe(0);
  });

  it("with validation off, an empty result coerces to 0 and no validator anywhere fires", async () => {
    const o = await runCorrupted(findResultTask("a-empty-lookup"), offPolicy);
    expect(o.ok).toBe(false);
    expect(o.failReason).toBe("wrong-answer");
    expect(o.finalAnswer).toBe("doubled population: 0");
    expect(o.wastedModelCalls).toBe(0);
  });

  it("last-hop garbage ships as the final answer when validation is off", async () => {
    const o = await runCorrupted(findResultTask("a-garbage-calc"), offPolicy);
    expect(o.ok).toBe(false);
    expect(o.failReason).toBe("wrong-answer");
    expect(o.finalAnswer).toBe(`doubled population: ${GARBAGE_VALUE}`);
  });
});

describe("runResultStudy", () => {
  it("is deterministic and shaped by the study policies", async () => {
    const inputs = { tasks: resultTasks, cities, notes };
    const a = await runResultStudy(inputs);
    const b = await runResultStudy(inputs);
    expect(a).toEqual(b);
    expect(a.policies).toEqual(["guarded", "guarded+reject", "guarded+retry2"]);
    expect(a.rows).toHaveLength(11);
    for (const row of a.rows) expect(row.outcomes).toHaveLength(3);
  });

  it("holds the study's headline invariants", async () => {
    const report = await runResultStudy({ tasks: resultTasks, cities, notes });
    for (const id of ["a-clean", "b-clean"]) {
      expect(findRow(report, id).outcomes.every((o) => o.ok)).toBe(true);
    }
    for (const id of ["a-lie-lookup", "a-lie-calc", "b-garbage-search"]) {
      const row = findRow(report, id);
      expect(row.outcomes.every((o) => !o.ok && o.failReason === "wrong-answer")).toBe(true);
    }
    for (const id of ["a-transient-lookup", "a-transient-calc"]) {
      const [off, rej, retry] = findRow(report, id).outcomes;
      expect(off!.ok).toBe(false);
      expect(rej!.ok).toBe(false);
      expect(rej!.failReason).toBe("bad-result");
      expect(retry!.ok).toBe(true);
    }
    const bomb = findRow(report, "a-bomb-lookup").outcomes;
    expect(bomb[0]!.tokensIn).toBeGreaterThan(5 * bomb[2]!.tokensIn);
    expect(bomb[2]!.failReason).toBe("bad-result");
    const rendered = renderResultReport(report);
    expect(rendered).toContain("bomb pricing");
    expect(rendered).not.toContain("UNEXPECTED");
  });
});
