/**
 * The result study: the dual failure mode. The original experiment breaks
 * tool CALLS and lets zod catch them before any tool runs; here every call
 * is valid and the RESULT comes back wrong. A seeded corruption wraps one
 * tool per task and rewrites its successful value - a plausible wrong
 * number (lie), an empty string, an html error page (garbage), a 20000-char
 * dump (bomb), or garbage on the first execution only (transient). The same
 * tasks run under the guarded policy with result validation off, on with
 * zero reruns (reject), and on with two reruns (retry), and the grid prices
 * where each failure is caught: at the result boundary, one hop later by
 * the next call's arg schema, or never.
 */

import { readFileSync } from "node:fs";
import { z } from "zod";
import { VirtualClock } from "../../06-rate-limiting/src/clock.js";
import { createRng } from "../../05-token-streaming/src/rng.js";
import { POLICIES, resultValidationPolicy, runTask, type LoopPolicy, type TaskOutcome } from "./loop.js";
import type { TaskSpec } from "./model.js";
import { buildRegistry, type CityRecord, type NoteRecord, type ToolSpec } from "./tools.js";

export type CorruptionFamily = "lie" | "empty" | "garbage" | "bomb" | "transient-garbage";

export interface CorruptionSpec {
  tool: string;
  family: CorruptionFamily;
}

export interface ResultTask {
  task: TaskSpec;
  corruption?: CorruptionSpec;
}

export const GARBAGE_VALUE = "<!doctype html><html>502 bad gateway</html>";
export const BOMB_CHARS = 20000;
const LIE_FACTOR = 10;

/** How each family rewrites a successful value. Deterministic on purpose. */
export function corruptValue(family: Exclude<CorruptionFamily, "transient-garbage">, value: string): string {
  switch (family) {
    case "lie": {
      const n = Number(value);
      if (value === "" || !Number.isFinite(n)) {
        throw new Error(`lie corruption needs a numeric value, got ${JSON.stringify(value)}`);
      }
      return String(n * LIE_FACTOR);
    }
    case "empty":
      return "";
    case "garbage":
      return GARBAGE_VALUE;
    case "bomb":
      return "x".repeat(BOMB_CHARS);
  }
}

/**
 * Wraps the corrupted tool so its successful results come back rewritten.
 * transient-garbage corrupts only the first execution, so a rerun sees the
 * clean value; every other family is persistent. Tool-reported errors pass
 * through untouched - the corruption models a lying upstream, not a broken
 * one.
 */
export function corruptRegistry(
  registry: Map<string, ToolSpec>,
  spec: CorruptionSpec | undefined,
): Map<string, ToolSpec> {
  if (spec === undefined) return registry;
  const target = registry.get(spec.tool);
  if (target === undefined) {
    throw new Error(`corruption targets unknown tool "${spec.tool}"`);
  }
  let executions = 0;
  const wrapped: ToolSpec = {
    ...target,
    run: async (args) => {
      const result = await target.run(args);
      const execution = executions++;
      if (!result.ok || result.value === undefined) return result;
      if (spec.family === "transient-garbage") {
        return execution === 0 ? { ok: true, value: GARBAGE_VALUE } : result;
      }
      return { ok: true, value: corruptValue(spec.family, result.value) };
    },
  };
  const out = new Map(registry);
  out.set(spec.tool, wrapped);
  return out;
}

const callSchema = z.strictObject({
  name: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
});

const corruptionSchema = z.strictObject({
  tool: z.string().min(1),
  family: z.enum(["lie", "empty", "garbage", "bomb", "transient-garbage"]),
});

const resultTaskSchema = z
  .strictObject({
    id: z.string().min(1),
    prompt: z.string().min(1),
    calls: z.array(callSchema).min(1),
    finalTemplate: z.string().min(1),
    expectedAnswer: z.string().min(1),
    corruption: corruptionSchema.optional(),
  })
  .refine((t) => t.corruption === undefined || t.calls.some((c) => c.name === t.corruption!.tool), {
    message: "corruption must target a tool the task calls",
  });

export function loadResultTasks(path: string): ResultTask[] {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const entries = z.array(resultTaskSchema).min(1).parse(raw);
  return entries.map((e) => ({
    task: {
      id: e.id,
      prompt: e.prompt,
      intents: e.calls.map((call) => ({
        call: { type: "tool_call" as const, name: call.name, args: call.args },
        flawKind: "none" as const,
        correctsAfter: 0,
      })),
      finalTemplate: e.finalTemplate,
      expectedAnswer: e.expectedAnswer,
      fetchTransientFailures: 0,
    },
    ...(e.corruption !== undefined ? { corruption: e.corruption } : {}),
  }));
}

const BASE_SEED = 0xd0e5;

export function resultSeedFor(policyIndex: number, taskIndex: number): number {
  return BASE_SEED + policyIndex * 10007 + taskIndex * 101;
}

export function resultStudyPolicies(): LoopPolicy[] {
  const guarded = POLICIES.find((p) => p.name === "guarded");
  if (guarded === undefined) throw new Error("guarded policy missing");
  return [guarded, resultValidationPolicy(0), resultValidationPolicy(2)];
}

export interface ResultRow {
  id: string;
  family: CorruptionFamily | "none";
  target: string;
  /** One outcome per study policy, in resultStudyPolicies() order. */
  outcomes: TaskOutcome[];
}

export interface ResultReport {
  policies: string[];
  rows: ResultRow[];
}

export interface ResultStudyInputs {
  tasks: ResultTask[];
  cities: CityRecord[];
  notes: NoteRecord[];
}

export async function runResultStudy(inputs: ResultStudyInputs): Promise<ResultReport> {
  const policies = resultStudyPolicies();
  const clock = new VirtualClock();
  const done = (async () => {
    const rows: ResultRow[] = inputs.tasks.map((rt) => ({
      id: rt.task.id,
      family: rt.corruption?.family ?? "none",
      target: rt.corruption?.tool ?? "-",
      outcomes: [],
    }));
    for (let p = 0; p < policies.length; p++) {
      for (let t = 0; t < inputs.tasks.length; t++) {
        const rt = inputs.tasks[t]!;
        const rng = createRng(resultSeedFor(p, t));
        const registry = corruptRegistry(
          buildRegistry({
            clock,
            rng,
            cities: inputs.cities,
            notes: inputs.notes,
            fetchTransientFailures: 0,
          }),
          rt.corruption,
        );
        rows[t]!.outcomes.push(await runTask(rt.task, policies[p]!, registry, clock, rng));
      }
    }
    return { policies: policies.map((pol) => pol.name), rows };
  })();
  return clock.runUntil(done);
}

export function findRow(report: ResultReport, id: string): ResultRow {
  const row = report.rows.find((r) => r.id === id);
  if (row === undefined) throw new Error(`no result row for task "${id}"`);
  return row;
}
