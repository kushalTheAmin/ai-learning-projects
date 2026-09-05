/**
 * The rotate-3 drifter does not walk past the signature guard. It is
 * caught by it, at the 7th emission - which is also where the feedback cap
 * would have fired, so the guard costs the same as no guard here and the
 * run records loop-detected rather than feedback-exhausted. The readme
 * said the opposite in three places and the drift report's own
 * `loop-detected=8` refuted it. These tests pin the trip round as a
 * function of the guard limit and the rotation length, and hold the prose
 * to it.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VirtualClock } from "../../06-rate-limiting/src/clock.js";
import { createRng } from "../../05-token-streaming/src/rng.js";
import { runDriftStudy } from "../src/driftStudy.js";
import { runTask, signatureGuardPolicy, type TaskOutcome } from "../src/loop.js";
import type { TaskSpec } from "../src/model.js";
import { loadCities, loadNotes, loadTasks } from "../src/tasks.js";
import { buildRegistry } from "../src/tools.js";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "..", "data");
const readmePath = join(here, "..", "README.md");

const cities = loadCities(join(dataDir, "cities.json"));
const notes = loadNotes(join(dataDir, "notes.json"));
const driftTasks = loadTasks(join(dataDir, "driftTasks.json"));
const originalTasks = loadTasks(join(dataDir, "tasks.json"));

/** The feedback cap every drift policy runs with: 6 rounds, so the 7th emission dies. */
const CAP_EMISSION = 7;

function findTask(id: string): TaskSpec {
  const t = driftTasks.find((x) => x.id === id);
  if (t === undefined) throw new Error(`no drift task ${id}`);
  return t;
}

async function runAtLimit(id: string, limit: number, seed = 7): Promise<TaskOutcome> {
  const task = findTask(id);
  const clock = new VirtualClock();
  const rng = createRng(seed);
  const registry = buildRegistry({
    clock,
    rng,
    cities,
    notes,
    fetchTransientFailures: task.fetchTransientFailures,
  });
  return clock.runUntil(runTask(task, signatureGuardPolicy(limit), registry, clock, rng));
}

/** Readme text with runs of whitespace collapsed, so a line wrap cannot hide a claim. */
function readmeFlat(): string {
  return readFileSync(readmePath, "utf8").replace(/\s+/g, " ").toLowerCase();
}

/** The readme minus its `## fixes` section, which quotes the sentences it retired. */
function readmeLiveProse(): string {
  const full = readFileSync(readmePath, "utf8");
  const start = full.indexOf("\n## fixes");
  if (start === -1) throw new Error("readme has no ## fixes section");
  const rest = full.slice(start + 1);
  const end = rest.indexOf("\n## ", 1);
  const fixes = end === -1 ? rest : rest.slice(0, end + 1);
  return full.replace(fixes, "").replace(/\s+/g, " ").toLowerCase();
}

describe("the rotate-3 drifter is caught by the signature guard, not the cap", () => {
  it("dies loop-detected at the 7th emission under the published limit of 3", async () => {
    const o = await runAtLimit("shape-drift-rotate3", 3);
    expect(o.ok).toBe(false);
    expect(o.failReason).toBe("loop-detected");
    expect(o.modelCalls).toBe(CAP_EMISSION);
  });

  it("trips the guard at (limit - 1) * cycle + 1 until the cap overtakes it", async () => {
    // rotate3 cycles 3 signatures, alternate cycles 2, value-drift repeats 1.
    const cases: Array<{ id: string; cycle: number }> = [
      { id: "shape-drift-rotate3", cycle: 3 },
      { id: "shape-drift-alternate", cycle: 2 },
      { id: "value-drift-calc-op", cycle: 1 },
    ];
    for (const { id, cycle } of cases) {
      for (const limit of [2, 3, 4, 5, 6]) {
        const predicted = (limit - 1) * cycle + 1;
        const o = await runAtLimit(id, limit);
        if (predicted <= CAP_EMISSION) {
          expect([id, limit, o.failReason, o.modelCalls]).toEqual([
            id,
            limit,
            "loop-detected",
            predicted,
          ]);
        } else {
          // The guard would fire later than the cap, so the cap wins first.
          expect([id, limit, o.failReason, o.modelCalls]).toEqual([
            id,
            limit,
            "feedback-exhausted",
            CAP_EMISSION,
          ]);
        }
      }
    }
  });

  it("only escapes to the cap once the limit is raised past 3", async () => {
    expect((await runAtLimit("shape-drift-rotate3", 3)).failReason).toBe("loop-detected");
    expect((await runAtLimit("shape-drift-rotate3", 4)).failReason).toBe("feedback-exhausted");
  });

  it("leaves the signature guard with no cap failures on the whole drift suite", async () => {
    const report = await runDriftStudy({
      tasks: driftTasks,
      originalTasks,
      cities,
      notes,
    });
    const sig = report.perPolicy.find((p) => p.policy === "guarded-sig");
    expect(sig).toBeDefined();
    // Every one of the 8 failures is the guard firing; rotate-3 is one of them.
    expect(sig!.failReasons).toEqual({ "loop-detected": 8 });
    expect(sig!.failReasons["feedback-exhausted"]).toBeUndefined();
  });

  it("still costs exactly what no guard costs on rotate-3", async () => {
    const guardTrips = await runAtLimit("shape-drift-rotate3", 3);
    const capOnly = await runAtLimit("shape-drift-rotate3", 99);
    expect(capOnly.failReason).toBe("feedback-exhausted");
    expect(guardTrips.modelCalls).toBe(capOnly.modelCalls);
    expect(guardTrips.tokensIn).toBe(capOnly.tokensIn);
    expect(guardTrips.tokensOut).toBe(capOnly.tokensOut);
  });
});

describe("the readme says what the run says about rotation", () => {
  it("does not claim rotate-3 walks past the guard or dies in the cap", () => {
    const prose = readmeLiveProse();
    expect(prose).not.toContain("walks past the guard entirely");
    expect(prose).not.toContain("dies in the feedback cap at 7");
  });

  it("does not claim the rotate-3 drifter beats both guard keys", () => {
    expect(readmeLiveProse()).not.toContain("beats both guard keys");
  });

  it("names the guard as what kills rotate-3, at the same price as no guard", () => {
    const prose = readmeLiveProse();
    // the guard fires, and the run's own failure count says so
    expect(prose).toContain("all 8 of guarded-sig's failures are loop-detected");
    expect(prose).toContain("same price as no guard");
    // the trip rule, and the tie it produces at limit 3
    expect(prose).toContain("(l-1)*c+1");
    expect(prose).toContain("a tie, not an escape");
  });

  it("records that raising the limit to 4 is what actually loses the rotation", () => {
    const prose = readmeLiveProse();
    expect(prose).toContain("at limit 4 rotate-3's trip round moves to 10");
    // the saturation is checkable off the published sweep column
    expect(prose).toContain("+9, +6, +4, +4");
  });

  it("keeps the retired sentence quoted in the fixes section", () => {
    // The fix entry is the version history; it must still show what it retired.
    expect(readmeFlat()).toContain("beats both guard keys");
  });
});
