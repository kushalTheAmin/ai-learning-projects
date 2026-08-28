import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { flawGroup, runExperiment, type ExperimentReport } from "../src/experiment.js";
import { MODEL_LATENCY_BASE_MS } from "../src/loop.js";
import { loadCities, loadNotes, loadTasks } from "../src/tasks.js";
import { renderReport } from "../src/report.js";

const dataDir = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const inputs = {
  tasks: loadTasks(join(dataDir, "tasks.json")),
  cities: loadCities(join(dataDir, "cities.json")),
  notes: loadNotes(join(dataDir, "notes.json")),
};

let cached: ExperimentReport | undefined;
async function report(): Promise<ExperimentReport> {
  cached ??= await runExperiment(inputs);
  return cached;
}

function policyRow(r: ExperimentReport, name: string) {
  const row = r.perPolicy.find((p) => p.policy === name);
  if (row === undefined) throw new Error(`missing policy ${name}`);
  return row;
}

describe("experiment over the committed dataset", () => {
  it("runs all 25 tasks under all three policies", async () => {
    const r = await report();
    expect(r.perPolicy.map((p) => p.policy)).toEqual(["strict", "feedback", "guarded"]);
    for (const p of r.perPolicy) expect(p.tasks).toBe(25);
  });

  it("strict completes exactly the tasks with no flawed first emission", async () => {
    const r = await report();
    const flawless = inputs.tasks.filter((t) => flawGroup(t) === undefined).length;
    expect(policyRow(r, "strict").completed).toBe(flawless);
    expect(policyRow(r, "strict").failReasons).toEqual({ "validation-error": 25 - flawless });
  });

  it("feedback beats strict on completion; the guard costs exactly the slow corrector", async () => {
    const r = await report();
    const strict = policyRow(r, "strict");
    const feedback = policyRow(r, "feedback");
    const guarded = policyRow(r, "guarded");
    expect(feedback.completed).toBeGreaterThan(strict.completed);
    expect(feedback.completed).toBe(22); // everything but the 3 stubborn tasks
    expect(guarded.completed).toBe(21); // loses the slow corrector too
    expect(guarded.failReasons).toEqual({ "loop-detected": 4 });
  });

  it("the guard saves tokens and model calls on stubborn tasks", async () => {
    const r = await report();
    expect(r.stubborn.tasks).toBe(3);
    expect(r.stubborn.guardedModelCalls).toBeLessThan(r.stubborn.feedbackModelCalls);
    expect(r.stubborn.guardedTokens).toBeLessThan(r.stubborn.feedbackTokens);
    expect(r.stubborn.guardedCostUsd).toBeLessThan(r.stubborn.feedbackCostUsd);
  });

  it("every flaw group pays at least one extra model call over its clean twin", async () => {
    const r = await report();
    expect(r.flawCosts.map((f) => f.group).sort()).toEqual([
      "extra-field",
      "missing-field",
      "slow-corrector",
      "stubborn",
      "unknown-tool",
      "wrong-type",
    ]);
    for (const row of r.flawCosts) {
      expect(row.meanExtraModelCalls).toBeGreaterThanOrEqual(1);
      expect(row.meanExtraTokens).toBeGreaterThan(0);
      expect(row.meanExtraCostUsd).toBeGreaterThan(0);
    }
  });

  it("correcting flaw groups complete every task under the guarded policy", async () => {
    const r = await report();
    for (const row of r.flawCosts) {
      if (row.group === "stubborn" || row.group === "slow-corrector") {
        expect(row.completed).toBe(0);
      } else {
        expect(row.completed).toBe(row.tasks);
      }
    }
  });

  it("an extra model call never prices below one model call of latency", async () => {
    const r = await report();
    for (const row of r.flawCosts) {
      // A group that completes every task runs exactly the tool calls its
      // twins run, so the whole paired difference is extra model calls. Each
      // of those costs at least MODEL_LATENCY_BASE_MS of virtual time, which
      // only holds if the twin replays the flawed run's latency draws — run
      // it on a different seed and the shared calls stop cancelling.
      if (row.completed !== row.tasks) continue;
      expect(row.meanExtraMs).toBeGreaterThanOrEqual(
        MODEL_LATENCY_BASE_MS * row.meanExtraModelCalls,
      );
    }
  });

  it("wasted model calls order: strict < guarded < feedback", async () => {
    const r = await report();
    const wasted = (name: string) => policyRow(r, name).wastedModelCalls;
    expect(wasted("strict")).toBeLessThan(wasted("guarded"));
    expect(wasted("guarded")).toBeLessThan(wasted("feedback"));
  });

  it("virtual latency is positive and p95 >= mean is not assumed, only ordering", async () => {
    const r = await report();
    for (const p of r.perPolicy) {
      expect(p.meanTaskMs).toBeGreaterThan(0);
      expect(p.p95TaskMs).toBeGreaterThan(0);
    }
  });

  it("is fully deterministic across runs", async () => {
    const first = await runExperiment(inputs);
    const second = await runExperiment(inputs);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("renders a report containing the headline sections", async () => {
    const text = renderReport(await report());
    expect(text).toContain("policy comparison over 25 tasks");
    expect(text).toContain("what malformed args cost");
    expect(text).toContain("stubborn model (3 tasks that never correct)");
    expect(text).toContain("strict");
    expect(text).toContain("feedback");
    expect(text).toContain("guarded");
  });
});

describe("flawGroup", () => {
  it("classifies tasks the way the pricing table groups them", () => {
    const byId = new Map(inputs.tasks.map((t) => [t.id, t]));
    expect(flawGroup(byId.get("calc-add")!)).toBeUndefined();
    expect(flawGroup(byId.get("wrong-type-calc")!)).toBe("wrong-type");
    expect(flawGroup(byId.get("stubborn-missing")!)).toBe("stubborn");
    expect(flawGroup(byId.get("slow-corrector")!)).toBe("slow-corrector");
    expect(flawGroup(byId.get("chain-mid-flaw")!)).toBe("wrong-type");
  });
});
