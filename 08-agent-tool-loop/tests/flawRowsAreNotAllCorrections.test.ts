/**
 * The flaw-pricing table has six rows and the prose under it priced all six
 * as one-round corrections. Two of them never corrected: stubborn and
 * slow-corrector complete 0 of their 4 tasks, and every one of those 4 ends
 * loop-detected at the 3rd emission against a clean twin that finishes in 2
 * model calls - so the 1.0 extra model call they print is the guard's third
 * strike, not a correction being paid for. These tests pin which rows
 * recovered and which died, pin the extra cost of the ones that recovered,
 * and hold the prose to the split.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VirtualClock } from "../../06-rate-limiting/src/clock.js";
import {
  flawGroup,
  runExperiment,
  runOne,
  seedFor,
  type ExperimentReport,
  type FlawCostRow,
} from "../src/experiment.js";
import { DEFAULT_GUARD_LIMIT, POLICIES } from "../src/loop.js";
import { cleanTwin } from "../src/model.js";
import { loadCities, loadNotes, loadTasks } from "../src/tasks.js";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "..", "data");
const readmePath = join(here, "..", "README.md");

const cities = loadCities(join(dataDir, "cities.json"));
const notes = loadNotes(join(dataDir, "notes.json"));
const tasks = loadTasks(join(dataDir, "tasks.json"));

/** The rows whose tasks recover, and the rows whose tasks are aborted. */
const CORRECTING = ["wrong-type", "missing-field", "extra-field", "unknown-tool"];
const ABORTING = ["stubborn", "slow-corrector"];

let cached: Promise<ExperimentReport> | undefined;
function report(): Promise<ExperimentReport> {
  cached ??= runExperiment({ tasks, cities, notes });
  return cached;
}

function row(report: ExperimentReport, group: string): FlawCostRow {
  const found = report.flawCosts.find((r) => r.group === group);
  if (found === undefined) throw new Error(`no flaw-cost row for ${group}`);
  return found;
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

describe("two of the six flaw-cost rows never corrected", () => {
  it("prices exactly these six groups", async () => {
    const groups = (await report()).flawCosts.map((r) => r.group);
    expect([...groups].sort()).toEqual([...CORRECTING, ...ABORTING].sort());
  });

  it("the correcting rows complete every task they price", async () => {
    const r = await report();
    for (const group of CORRECTING) {
      const costRow = row(r, group);
      expect([group, costRow.completed]).toEqual([group, costRow.tasks]);
    }
  });

  it("the aborting rows complete none of their 4 tasks", async () => {
    const r = await report();
    const rows = ABORTING.map((g) => row(r, g));
    expect(rows.map((x) => x.completed)).toEqual([0, 0]);
    expect(rows.reduce((acc, x) => acc + x.tasks, 0)).toBe(4);
  });

  it("the aborting rows' one extra model call is the guard's third strike", async () => {
    const r = await report();
    const guardedIndex = POLICIES.findIndex((p) => p.name === "guarded");
    const guarded = POLICIES[guardedIndex]!;
    const guardedOutcomes = r.perPolicy.find((p) => p.policy === "guarded")!.outcomes;
    let aborted = 0;
    for (let t = 0; t < tasks.length; t++) {
      const task = tasks[t]!;
      const group = flawGroup(task);
      if (group === undefined || !ABORTING.includes(group)) continue;
      aborted++;
      // The flawed run dies on the guard, never on a correction.
      const flawed = guardedOutcomes[t]!;
      expect([task.id, flawed.ok, flawed.failReason]).toEqual([task.id, false, "loop-detected"]);
      expect([task.id, flawed.modelCalls]).toEqual([task.id, DEFAULT_GUARD_LIMIT]);
      // Its clean twin needs one dispatch and one final answer, so the
      // difference the table prints is the third strike, not a retry.
      const clock = new VirtualClock();
      const twin = await clock.runUntil(
        runOne(
          cleanTwin(task),
          guarded,
          { tasks, cities, notes },
          clock,
          seedFor(guardedIndex, t),
        ),
      );
      expect([task.id, twin.ok, twin.modelCalls]).toEqual([task.id, true, 2]);
      expect(flawed.modelCalls - twin.modelCalls).toBe(1);
    }
    expect(aborted).toBe(4);
  });

  it("the correcting rows cost 139 to 218 extra tokens, the published range", async () => {
    const r = await report();
    const extras = CORRECTING.map((g) => Math.round(row(r, g).meanExtraTokens));
    expect(extras).toEqual([218, 139, 146, 151]);
    expect(Math.min(...extras)).toBe(139);
    expect(Math.max(...extras)).toBe(218);
    // Only wrong-type pays more than one extra call, and only because
    // wrong-type-search-limit takes two feedback rounds.
    expect(row(r, "wrong-type").meanExtraModelCalls).toBeCloseTo(1.25, 10);
    for (const group of ["missing-field", "extra-field", "unknown-tool", ...ABORTING]) {
      expect([group, row(r, group).meanExtraModelCalls]).toEqual([group, 1]);
    }
  });
});

describe("the readme reads the table row by row", () => {
  it("drops the sentence that priced all six rows as a correction", () => {
    expect(readmeLiveProse()).not.toContain(
      "a one-round correction costs one extra model call and roughly 140 to 220 extra tokens",
    );
  });

  it("states the correcting rows' own range", () => {
    const prose = readmeLiveProse();
    expect(prose).toContain("139 to 218 extra tokens");
  });

  it("names the aborting rows and what their extra call actually is", () => {
    const prose = readmeLiveProse();
    expect(prose).toContain("complete 0 of their 4 tasks");
    expect(prose).toContain("the guard's third strike, not a correction");
  });

  it("keeps the retired sentence quoted in the fixes section", () => {
    const full = readFileSync(readmePath, "utf8").replace(/\s+/g, " ").toLowerCase();
    expect(full).toContain(
      "a one-round correction costs one extra model call and roughly 140 to 220 extra tokens",
    );
  });
});
