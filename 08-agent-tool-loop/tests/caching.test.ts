import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VirtualClock } from "../../06-rate-limiting/src/clock.js";
import { createRng } from "../../05-token-streaming/src/rng.js";
import {
  ANTHROPIC_RATES,
  UNCACHED_RATES,
  computeCachingReport,
  priceOutcomes,
  priceTrace,
} from "../src/caching.js";
import { runExperiment, type ExperimentReport } from "../src/experiment.js";
import { POLICIES, runTask, type LoopPolicy, type TaskOutcome } from "../src/loop.js";
import { PRICING } from "../src/messages.js";
import { isStubborn, type TaskSpec } from "../src/model.js";
import { renderCachingReport } from "../src/report.js";
import { buildRegistry } from "../src/tools.js";
import { loadCities, loadNotes, loadTasks } from "../src/tasks.js";

const dataDir = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const inputs = {
  tasks: loadTasks(join(dataDir, "tasks.json")),
  cities: loadCities(join(dataDir, "cities.json")),
  notes: loadNotes(join(dataDir, "notes.json")),
};

let cachedReport: ExperimentReport | undefined;
async function report(): Promise<ExperimentReport> {
  cachedReport ??= await runExperiment(inputs);
  return cachedReport;
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
    cities: inputs.cities,
    notes: inputs.notes,
    fetchTransientFailures: task.fetchTransientFailures,
  });
  return clock.runUntil(runTask(task, pol, registry, clock, rng));
}

describe("priceTrace", () => {
  it("bills a single call as pure cache write", () => {
    const bill = priceTrace([100], 20, ANTHROPIC_RATES);
    expect(bill.cacheReadTokens).toBe(0);
    expect(bill.cacheWriteTokens).toBe(100);
    expect(bill.effectiveInputTokens).toBe(125);
    expect(bill.costUsd).toBeCloseTo((125 * 3 + 20 * 15) / 1_000_000, 12);
  });

  it("telescopes writes to the final call's input", () => {
    const bill = priceTrace([100, 160, 300], 0, ANTHROPIC_RATES);
    expect(bill.cacheWriteTokens).toBe(300);
    expect(bill.cacheReadTokens).toBe(100 + 160);
  });

  it("reproduces the uncached bill at readMult=writeMult=1", () => {
    const trace = [37, 91, 91, 240];
    const bill = priceTrace(trace, 55, UNCACHED_RATES);
    expect(bill.effectiveInputTokens).toBe(37 + 91 + 91 + 240);
    expect(bill.costUsd).toBeCloseTo((459 * PRICING.inputPerMTok + 55 * PRICING.outputPerMTok) / 1_000_000, 12);
  });

  it("handles an empty trace and a flat trace", () => {
    expect(priceTrace([], 0, ANTHROPIC_RATES).costUsd).toBe(0);
    const flat = priceTrace([50, 50], 0, ANTHROPIC_RATES);
    expect(flat.cacheWriteTokens).toBe(50);
    expect(flat.cacheReadTokens).toBe(50);
  });

  it("rejects a shrinking trace", () => {
    expect(() => priceTrace([100, 90], 0, ANTHROPIC_RATES)).toThrow(/append-only/);
  });
});

describe("recorded traces", () => {
  it("per-call traces sum to the totals and grow monotonically", async () => {
    const o = await run(inputs.tasks[0]!, policy("guarded"));
    expect(o.inputTokensPerCall).toHaveLength(o.modelCalls);
    expect(o.outputTokensPerCall).toHaveLength(o.modelCalls);
    expect(o.inputTokensPerCall.reduce((a, b) => a + b, 0)).toBe(o.tokensIn);
    expect(o.outputTokensPerCall.reduce((a, b) => a + b, 0)).toBe(o.tokensOut);
    for (let i = 1; i < o.inputTokensPerCall.length; i++) {
      expect(o.inputTokensPerCall[i]!).toBeGreaterThan(o.inputTokensPerCall[i - 1]!);
    }
  });

  it("every outcome in the full experiment carries a consistent trace", async () => {
    const r = await report();
    for (const p of r.perPolicy) {
      for (const o of p.outcomes) {
        expect(o.inputTokensPerCall).toHaveLength(o.modelCalls);
        expect(o.inputTokensPerCall.reduce((a, b) => a + b, 0)).toBe(o.tokensIn);
        expect(o.outputTokensPerCall.reduce((a, b) => a + b, 0)).toBe(o.tokensOut);
      }
    }
  });
});

describe("caching report over the committed dataset", () => {
  it("uncached pricing matches each policy's published cost exactly", async () => {
    const r = await report();
    for (const p of r.perPolicy) {
      expect(priceOutcomes(p.outcomes, UNCACHED_RATES).costUsd).toBeCloseTo(p.costUsd, 10);
    }
  });

  it("recomputes the published 80.9% token-based stubborn saving", async () => {
    const c = computeCachingReport(await report(), inputs.tasks);
    expect(c.stubbornTasks).toBe(inputs.tasks.filter(isStubborn).length);
    expect(c.stubbornTasks).toBeGreaterThan(0);
    expect(c.stubbornTokensSavedPct).toBeCloseTo(80.9, 1);
  });

  it("caching cuts every policy's bill, feedback most", async () => {
    const c = computeCachingReport(await report(), inputs.tasks);
    for (const row of c.perPolicy) {
      expect(row.cachedCostUsd).toBeLessThan(row.uncachedCostUsd);
    }
    const saved = new Map(c.perPolicy.map((r) => [r.policy, r.cachingSavedPct]));
    expect(saved.get("feedback")!).toBeGreaterThan(saved.get("strict")!);
  });

  it("the guard still saves money under cached pricing, but a smaller share", async () => {
    const c = computeCachingReport(await report(), inputs.tasks);
    const uncached = c.stubborn.find((s) => s.label === "uncached")!;
    const cached = c.stubborn.find((s) => s.label !== "uncached")!;
    expect(uncached.guardSavedUsd).toBeGreaterThan(0);
    expect(cached.guardSavedUsd).toBeGreaterThan(0);
    expect(cached.guardSavedPct).toBeLessThan(uncached.guardSavedPct);
    expect(cached.guardSavedUsd).toBeLessThan(uncached.guardSavedUsd);
  });

  it("guard saving shrinks monotonically as reads get cheaper", async () => {
    const c = computeCachingReport(await report(), inputs.tasks);
    const pcts = c.sweep.map((s) => s.guardSavedPct);
    for (let i = 1; i < pcts.length; i++) {
      expect(pcts[i]!).toBeGreaterThan(pcts[i - 1]!);
    }
    const atOne = c.sweep.find((s) => s.readMult === 1)!;
    const uncached = c.stubborn.find((s) => s.label === "uncached")!;
    expect(atOne.guardSavedPct).toBeGreaterThan(c.sweep[0]!.guardSavedPct);
    expect(uncached.guardSavedPct).toBeGreaterThan(c.sweep[2]!.guardSavedPct);
  });

  it("stubborn composition components sum to each policy's cached cost", async () => {
    const c = computeCachingReport(await report(), inputs.tasks);
    const cached = c.stubborn.find((s) => s.label !== "uncached")!;
    const byPolicy = new Map(c.stubbornComposition.map((x) => [x.policy, x]));
    const f = byPolicy.get("feedback")!;
    const g = byPolicy.get("guarded")!;
    expect(f.readUsd + f.writeUsd + f.outputUsd).toBeCloseTo(cached.feedbackCostUsd, 10);
    expect(g.readUsd + g.writeUsd + g.outputUsd).toBeCloseTo(cached.guardedCostUsd, 10);
  });

  it("renders without NaN and names both pricings", async () => {
    const text = renderCachingReport(computeCachingReport(await report(), inputs.tasks));
    expect(text).toContain("uncached");
    expect(text).toContain("cached 0.1x/1.25x");
    expect(text).not.toContain("NaN");
  });
});
