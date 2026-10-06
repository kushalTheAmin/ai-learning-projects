/**
 * The limit sweep's stubborn-model-call column flattens as the limit rises,
 * and the readme credited all of that to the feedback cap. Re-running the
 * sweep with the cap lifted separates the two mechanisms: at limit 4 the cap
 * accounts for 1 model call and the authored drift lists running out account
 * for the other 2. Each list carries 6 variants and then repeats its last
 * one, so from the 7th emission every rotation is a fixed point, the counts
 * accelerate, and the (limit-1)*cycle+1 trip rule stops applying - which is
 * why rotate-3 trips at 8 under limit 4 and not the 10 the rule predicts.
 * These tests pin the control, the rule's range, and hold the prose to both.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VirtualClock } from "../../06-rate-limiting/src/clock.js";
import { createRng } from "../../05-token-streaming/src/rng.js";
import { runDriftStudy, type DriftReport } from "../src/driftStudy.js";
import { runTask, signatureGuardPolicy, type TaskOutcome } from "../src/loop.js";
import { renderDriftReport } from "../src/report.js";
import { loadCities, loadNotes, loadTasks } from "../src/tasks.js";
import { buildRegistry } from "../src/tools.js";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "..", "data");
const readmePath = join(here, "..", "README.md");

const cities = loadCities(join(dataDir, "cities.json"));
const notes = loadNotes(join(dataDir, "notes.json"));
const driftTasks = loadTasks(join(dataDir, "driftTasks.json"));
const originalTasks = loadTasks(join(dataDir, "tasks.json"));

/** The feedback cap every published drift policy runs with: the 7th emission dies. */
const CAP_EMISSION = 7;

let cached: Promise<DriftReport> | undefined;
function report(): Promise<DriftReport> {
  cached ??= runDriftStudy({ tasks: driftTasks, originalTasks, cities, notes });
  return cached;
}

/** Runs one drift task at a guard limit, optionally with the feedback cap lifted. */
async function runAtLimit(id: string, limit: number, lifted = false): Promise<TaskOutcome> {
  const task = driftTasks.find((x) => x.id === id);
  if (task === undefined) throw new Error(`no drift task ${id}`);
  const base = signatureGuardPolicy(limit);
  const policy = lifted ? { ...base, maxFeedbackPerIntent: base.maxModelCalls } : base;
  const clock = new VirtualClock();
  const rng = createRng(7);
  const registry = buildRegistry({
    clock,
    rng,
    cities,
    notes,
    fetchTransientFailures: task.fetchTransientFailures,
  });
  return clock.runUntil(runTask(task, policy, registry, clock, rng));
}

function steps(xs: readonly number[]): number[] {
  return xs.slice(1).map((x, i) => x - xs[i]!);
}

function readmeLiveProse(): string {
  const full = readFileSync(readmePath, "utf8");
  const start = full.indexOf("\n## fixes");
  if (start === -1) throw new Error("readme has no ## fixes section");
  const rest = full.slice(start + 1);
  const end = rest.indexOf("\n## ", 1);
  const fixes = end === -1 ? rest : rest.slice(0, end + 1);
  return full.replace(fixes, "").replace(/\s+/g, " ").toLowerCase();
}

describe("the drift lists run out, and that is most of what flattens the sweep", () => {
  it("every authored drift list clamps to its last variant from the 7th emission", () => {
    // The clamp is what breaks the rotation, so the suite has to actually have it.
    for (const task of driftTasks) {
      for (const intent of task.intents) {
        if (intent.flawDrift === undefined) continue;
        expect(intent.flawDrift.length + 1).toBeLessThanOrEqual(CAP_EMISSION);
      }
    }
  });

  it("the trip rule holds while the rotation rotates and breaks once it clamps", async () => {
    const cases: Array<{ id: string; cycle: number }> = [
      { id: "shape-drift-rotate3", cycle: 3 },
      { id: "shape-drift-alternate", cycle: 2 },
      { id: "value-drift-calc-op", cycle: 1 },
    ];
    for (const { id, cycle } of cases) {
      for (const limit of [2, 3, 4, 5, 6]) {
        const predicted = (limit - 1) * cycle + 1;
        const o = await runAtLimit(id, limit, true);
        expect(o.failReason).toBe("loop-detected");
        if (predicted <= CAP_EMISSION) {
          expect([id, limit, o.modelCalls]).toEqual([id, limit, predicted]);
        } else {
          // Past the clamp the rotation is a fixed point, so the guard arrives early.
          expect(o.modelCalls).toBeLessThan(predicted);
        }
      }
    }
  });

  it("puts rotate-3's real trip round at limit 4 at 8, not the rule's 10", async () => {
    const lifted = await runAtLimit("shape-drift-rotate3", 4, true);
    expect(lifted.failReason).toBe("loop-detected");
    expect(lifted.modelCalls).toBe(8);
    // Still past the cap, so the published run dies feedback-exhausted anyway.
    expect(lifted.modelCalls).toBeGreaterThan(CAP_EMISSION);
    const published = await runAtLimit("shape-drift-rotate3", 4);
    expect(published.failReason).toBe("feedback-exhausted");
    expect(published.modelCalls).toBe(CAP_EMISSION);
  });
});

describe("the sweep carries its own cap control", () => {
  it("prices the published column against the same sweep with the cap lifted", async () => {
    const sweep = (await report()).sweep;
    expect(sweep.map((r) => r.limit)).toEqual([2, 3, 4, 5, 6]);
    expect(sweep.map((r) => r.stubbornModelCalls)).toEqual([15, 24, 30, 34, 38]);
    expect(sweep.map((r) => r.stubbornModelCallsUncapped)).toEqual([15, 24, 31, 37, 43]);
  });

  it("splits the flattening: the cap takes 0, 0, 1, 3, 5 of it", async () => {
    const sweep = (await report()).sweep;
    const capAccountsFor = sweep.map((r) => r.stubbornModelCallsUncapped - r.stubbornModelCalls);
    expect(capAccountsFor).toEqual([0, 0, 1, 3, 5]);
    // The published column flattens harder than the cap alone explains.
    expect(steps(sweep.map((r) => r.stubbornModelCalls))).toEqual([9, 6, 4, 4]);
    expect(steps(sweep.map((r) => r.stubbornModelCallsUncapped))).toEqual([9, 7, 6, 6]);
  });

  it("records each shape drifter's uncapped trip round per limit", async () => {
    const sweep = (await report()).sweep;
    expect(sweep.map((r) => r.shapeTripRounds["shape-drift-rotate3"])).toEqual([4, 7, 8, 9, 10]);
    expect(sweep.map((r) => r.shapeTripRounds["shape-drift-alternate"])).toEqual([3, 5, 7, 8, 9]);
  });

  it("prints the control in the drift report", async () => {
    const text = renderDriftReport(await report());
    expect(text).toContain("cap control");
    expect(text).toContain("cap-lifted");
    expect(text).toContain("shape-drift-rotate3=8");
  });
});

describe("the readme says what the control says", () => {
  it("drops the claim that the cap is what flattens the column", () => {
    expect(readmeLiveProse()).not.toContain("instead of +6 a row");
  });

  it("drops the rule-predicted trip round the run never produces", () => {
    expect(readmeLiveProse()).not.toContain("trip round moves to 10");
  });

  it("states the measured trip round and the measured split", () => {
    const prose = readmeLiveProse();
    expect(prose).toContain("rotate-3 trips at emission 8");
    expect(prose).toContain("+9, +7, +6, +6");
    expect(prose).toContain("the cap accounts for 1 model call and the clamp for the other 2");
  });

  it("keeps the retired sentences quoted in the fixes section", () => {
    const full = readFileSync(readmePath, "utf8").replace(/\s+/g, " ").toLowerCase();
    expect(full).toContain("trip round moves to 10");
    expect(full).toContain("instead of +6 a row");
  });
});
