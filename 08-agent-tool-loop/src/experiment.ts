/**
 * Runs every task under every loop policy on a virtual clock, then prices
 * the flaws: each flawed task is re-run as its clean twin under the same
 * policy, and the difference is what that malformed-args habit cost in
 * model calls, tokens, dollars, and latency.
 */

import { VirtualClock } from "../../06-rate-limiting/src/clock.js";
import { percentile } from "../../06-rate-limiting/src/percentile.js";
import { createRng } from "../../05-token-streaming/src/rng.js";
import { POLICIES, runTask, type LoopPolicy, type TaskOutcome } from "./loop.js";
import { cleanTwin, isStubborn, taskFlawKinds, type TaskSpec } from "./model.js";
import { buildRegistry, type CityRecord, type NoteRecord } from "./tools.js";

const BASE_SEED = 0xa9e17;

/**
 * One seed per (policy, task). The clean twin of a task reuses the seed of
 * the run it is subtracted from, so both draw the same latency jitter for
 * the calls they share and the difference is the marginal cost of the flaw
 * rather than the marginal cost plus two independent noise streams.
 */
export function seedFor(policyIndex: number, taskIndex: number): number {
  return BASE_SEED + policyIndex * 10007 + taskIndex * 101;
}

export interface PolicyAggregate {
  policy: string;
  tasks: number;
  completed: number;
  modelCalls: number;
  wastedModelCalls: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  meanTaskMs: number;
  p95TaskMs: number;
  failReasons: Record<string, number>;
  outcomes: TaskOutcome[];
}

export interface FlawCostRow {
  group: string;
  tasks: number;
  completed: number;
  meanExtraModelCalls: number;
  meanExtraTokens: number;
  meanExtraCostUsd: number;
  meanExtraMs: number;
}

export interface StubbornComparison {
  tasks: number;
  feedbackModelCalls: number;
  guardedModelCalls: number;
  feedbackTokens: number;
  guardedTokens: number;
  feedbackCostUsd: number;
  guardedCostUsd: number;
}

export interface ExperimentReport {
  perPolicy: PolicyAggregate[];
  /** Flaw pricing under the guarded policy, vs each task's clean twin. */
  flawCosts: FlawCostRow[];
  stubborn: StubbornComparison;
}

export interface ExperimentInputs {
  tasks: TaskSpec[];
  cities: CityRecord[];
  notes: NoteRecord[];
}

export async function runOne(
  task: TaskSpec,
  policy: LoopPolicy,
  inputs: ExperimentInputs,
  clock: VirtualClock,
  seed: number,
): Promise<TaskOutcome> {
  const rng = createRng(seed);
  const registry = buildRegistry({
    clock,
    rng,
    cities: inputs.cities,
    notes: inputs.notes,
    fetchTransientFailures: task.fetchTransientFailures,
  });
  return runTask(task, policy, registry, clock, rng);
}

export function aggregate(policy: string, outcomes: TaskOutcome[]): PolicyAggregate {
  const durations = outcomes.map((o) => o.virtualMs).sort((a, b) => a - b);
  const failReasons: Record<string, number> = {};
  for (const o of outcomes) {
    if (o.failReason !== undefined) {
      failReasons[o.failReason] = (failReasons[o.failReason] ?? 0) + 1;
    }
  }
  const sum = (f: (o: TaskOutcome) => number) => outcomes.reduce((acc, o) => acc + f(o), 0);
  return {
    policy,
    tasks: outcomes.length,
    completed: outcomes.filter((o) => o.ok).length,
    modelCalls: sum((o) => o.modelCalls),
    wastedModelCalls: sum((o) => o.wastedModelCalls),
    toolCalls: sum((o) => o.toolCalls),
    tokensIn: sum((o) => o.tokensIn),
    tokensOut: sum((o) => o.tokensOut),
    costUsd: sum((o) => o.costUsd),
    meanTaskMs: sum((o) => o.virtualMs) / outcomes.length,
    p95TaskMs: percentile(durations, 0.95),
    failReasons,
    outcomes,
  };
}

/** Group label used in the flaw-pricing table. */
export function flawGroup(task: TaskSpec): string | undefined {
  const kinds = taskFlawKinds(task);
  if (kinds.length === 0) return undefined;
  if (isStubborn(task)) return "stubborn";
  if (task.intents.some((i) => i.correctsAfter !== null && i.correctsAfter >= 3)) {
    return "slow-corrector";
  }
  return kinds[0];
}

export async function runExperiment(inputs: ExperimentInputs): Promise<ExperimentReport> {
  const clock = new VirtualClock();
  const done = (async () => {
    const perPolicy: PolicyAggregate[] = [];
    let guardedOutcomes: TaskOutcome[] = [];
    let guardedTwinOutcomes = new Map<string, TaskOutcome>();
    let feedbackOutcomes: TaskOutcome[] = [];

    for (let p = 0; p < POLICIES.length; p++) {
      const policy = POLICIES[p]!;
      const outcomes: TaskOutcome[] = [];
      for (let t = 0; t < inputs.tasks.length; t++) {
        const task = inputs.tasks[t]!;
        outcomes.push(await runOne(task, policy, inputs, clock, seedFor(p, t)));
      }
      perPolicy.push(aggregate(policy.name, outcomes));
      if (policy.name === "guarded") guardedOutcomes = outcomes;
      if (policy.name === "feedback") feedbackOutcomes = outcomes;
    }

    const guardedIndex = POLICIES.findIndex((p) => p.name === "guarded");
    const guardedPolicy = POLICIES[guardedIndex]!;
    for (let t = 0; t < inputs.tasks.length; t++) {
      const task = inputs.tasks[t]!;
      if (flawGroup(task) === undefined) continue;
      const twin = cleanTwin(task);
      guardedTwinOutcomes.set(
        task.id,
        await runOne(twin, guardedPolicy, inputs, clock, seedFor(guardedIndex, t)),
      );
    }

    const groups = new Map<string, { flawed: TaskOutcome[]; twins: TaskOutcome[] }>();
    for (let t = 0; t < inputs.tasks.length; t++) {
      const task = inputs.tasks[t]!;
      const group = flawGroup(task);
      if (group === undefined) continue;
      const flawed = guardedOutcomes[t]!;
      const twin = guardedTwinOutcomes.get(task.id)!;
      const bucket = groups.get(group) ?? { flawed: [], twins: [] };
      bucket.flawed.push(flawed);
      bucket.twins.push(twin);
      groups.set(group, bucket);
    }

    const flawCosts: FlawCostRow[] = [...groups.entries()].map(([group, { flawed, twins }]) => {
      const n = flawed.length;
      const mean = (f: (o: TaskOutcome) => number) =>
        (flawed.reduce((a, o) => a + f(o), 0) - twins.reduce((a, o) => a + f(o), 0)) / n;
      return {
        group,
        tasks: n,
        completed: flawed.filter((o) => o.ok).length,
        meanExtraModelCalls: mean((o) => o.modelCalls),
        meanExtraTokens: mean((o) => o.tokensIn + o.tokensOut),
        meanExtraCostUsd: mean((o) => o.costUsd),
        meanExtraMs: mean((o) => o.virtualMs),
      };
    });

    const stubbornIdx = inputs.tasks
      .map((task, i) => (isStubborn(task) ? i : -1))
      .filter((i) => i >= 0);
    const pick = (outcomes: TaskOutcome[], f: (o: TaskOutcome) => number) =>
      stubbornIdx.reduce((acc, i) => acc + f(outcomes[i]!), 0);
    const stubborn: StubbornComparison = {
      tasks: stubbornIdx.length,
      feedbackModelCalls: pick(feedbackOutcomes, (o) => o.modelCalls),
      guardedModelCalls: pick(guardedOutcomes, (o) => o.modelCalls),
      feedbackTokens: pick(feedbackOutcomes, (o) => o.tokensIn + o.tokensOut),
      guardedTokens: pick(guardedOutcomes, (o) => o.tokensIn + o.tokensOut),
      feedbackCostUsd: pick(feedbackOutcomes, (o) => o.costUsd),
      guardedCostUsd: pick(guardedOutcomes, (o) => o.costUsd),
    };

    return { perPolicy, flawCosts, stubborn };
  })();
  return clock.runUntil(done);
}
