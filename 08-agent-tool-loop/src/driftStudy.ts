/**
 * The drift study. The original stubborn tasks repeat one flawed call
 * verbatim, which is exactly what the exact-identity loop guard catches.
 * Here every flawed model mutates its broken call between rounds, and the
 * question is whether a guard keyed on the zod issue signature (paths and
 * codes, not values) still catches the burn, and what it kills that the
 * exact guard would have let finish. A limit sweep on the signature guard
 * then asks whether the trip count, not the key, is the real knob.
 */

import { VirtualClock } from "../../06-rate-limiting/src/clock.js";
import {
  aggregate,
  runOne,
  seedFor,
  type ExperimentInputs,
  type PolicyAggregate,
} from "./experiment.js";
import { POLICIES, signatureGuardPolicy, type LoopPolicy, type TaskOutcome } from "./loop.js";
import { isStubborn, type TaskSpec } from "./model.js";

export const DRIFT_CATEGORIES = [
  "value-drift",
  "extrakey-drift",
  "shape-drift",
  "slow-sig-corrector",
  "progressive",
] as const;

export type DriftCategory = (typeof DRIFT_CATEGORIES)[number];

export function driftCategory(task: TaskSpec): DriftCategory {
  const match = DRIFT_CATEGORIES.find((c) => task.id.startsWith(`${c}-`));
  if (match === undefined) throw new Error(`drift task id has no known category prefix: ${task.id}`);
  return match;
}

export interface CategoryRow {
  category: DriftCategory;
  tasks: number;
  /** Completions per policy, keyed by policy name. */
  completed: Record<string, number>;
  /** Mean model calls per task per policy. */
  meanModelCalls: Record<string, number>;
}

export interface StubbornDriftRow {
  policy: string;
  modelCalls: number;
  tokens: number;
  costUsd: number;
  /** Tokens saved vs the feedback policy on the same tasks. */
  savedTokensPct: number;
}

export interface SweepRow {
  limit: number;
  completed: number;
  /** Correctors the feedback policy finishes that this guard kills. */
  correctorsKilled: number;
  stubbornModelCalls: number;
  stubbornTokens: number;
  totalTokens: number;
}

export interface OriginalSuiteCheck {
  tasks: number;
  guardedCompleted: number;
  sigCompleted: number;
  /** Task ids whose (ok, failReason, modelCalls, tokens) differ between the two guards. */
  divergingTaskIds: string[];
}

export interface DriftReport {
  perPolicy: PolicyAggregate[];
  perCategory: CategoryRow[];
  stubbornTasks: number;
  stubbornDrift: StubbornDriftRow[];
  /** Ids the feedback policy completes but the named policy fails. */
  killedCorrectors: Record<string, string[]>;
  sweep: SweepRow[];
  originalSuite: OriginalSuiteCheck;
}

export interface DriftStudyInputs extends ExperimentInputs {
  /** The original 25-task suite, for the like-for-like guard check. */
  originalTasks: TaskSpec[];
}

const SWEEP_LIMITS = [2, 3, 4, 5, 6];

function policyByName(name: string): LoopPolicy {
  const p = POLICIES.find((x) => x.name === name);
  if (p === undefined) throw new Error(`no policy ${name}`);
  return p;
}

/**
 * Seeds mirror the main experiment's scheme with a disjoint policy-index
 * space so no (policy, task) pair shares a jitter stream with the original
 * study by accident. The original-suite check deliberately reuses the main
 * experiment's guarded seeds so guarded and guarded-sig see identical
 * latency draws on identical tasks.
 */
const DRIFT_POLICY_INDEX_BASE = 100;

async function runSuite(
  tasks: TaskSpec[],
  policy: LoopPolicy,
  policyIndex: number,
  inputs: ExperimentInputs,
  clock: VirtualClock,
): Promise<TaskOutcome[]> {
  const outcomes: TaskOutcome[] = [];
  for (let t = 0; t < tasks.length; t++) {
    outcomes.push(await runOne(tasks[t]!, policy, inputs, clock, seedFor(policyIndex, t)));
  }
  return outcomes;
}

export async function runDriftStudy(inputs: DriftStudyInputs): Promise<DriftReport> {
  const clock = new VirtualClock();
  const done = (async () => {
    const feedback = policyByName("feedback");
    const guarded = policyByName("guarded");
    const policies: LoopPolicy[] = [feedback, guarded, signatureGuardPolicy()];

    const byPolicy = new Map<string, TaskOutcome[]>();
    for (let p = 0; p < policies.length; p++) {
      const policy = policies[p]!;
      byPolicy.set(
        policy.name,
        await runSuite(inputs.tasks, policy, DRIFT_POLICY_INDEX_BASE + p, inputs, clock),
      );
    }

    const perPolicy = policies.map((p) => aggregate(p.name, byPolicy.get(p.name)!));

    const perCategory: CategoryRow[] = DRIFT_CATEGORIES.map((category) => {
      const idx = inputs.tasks
        .map((task, i) => (driftCategory(task) === category ? i : -1))
        .filter((i) => i >= 0);
      const completed: Record<string, number> = {};
      const meanModelCalls: Record<string, number> = {};
      for (const p of policies) {
        const outcomes = byPolicy.get(p.name)!;
        completed[p.name] = idx.filter((i) => outcomes[i]!.ok).length;
        meanModelCalls[p.name] =
          idx.reduce((acc, i) => acc + outcomes[i]!.modelCalls, 0) / idx.length;
      }
      return { category, tasks: idx.length, completed, meanModelCalls };
    });

    const stubbornIdx = inputs.tasks
      .map((task, i) => (isStubborn(task) ? i : -1))
      .filter((i) => i >= 0);
    const stubbornSum = (outcomes: TaskOutcome[], f: (o: TaskOutcome) => number) =>
      stubbornIdx.reduce((acc, i) => acc + f(outcomes[i]!), 0);
    const feedbackStubbornTokens = stubbornSum(
      byPolicy.get("feedback")!,
      (o) => o.tokensIn + o.tokensOut,
    );
    const stubbornDrift: StubbornDriftRow[] = policies.map((p) => {
      const outcomes = byPolicy.get(p.name)!;
      const tokens = stubbornSum(outcomes, (o) => o.tokensIn + o.tokensOut);
      return {
        policy: p.name,
        modelCalls: stubbornSum(outcomes, (o) => o.modelCalls),
        tokens,
        costUsd: stubbornSum(outcomes, (o) => o.costUsd),
        savedTokensPct: (100 * (feedbackStubbornTokens - tokens)) / feedbackStubbornTokens,
      };
    });

    const feedbackOutcomes = byPolicy.get("feedback")!;
    const killedBy = (outcomes: TaskOutcome[]): string[] =>
      inputs.tasks
        .map((task, i) => (feedbackOutcomes[i]!.ok && !outcomes[i]!.ok ? task.id : undefined))
        .filter((id): id is string => id !== undefined);
    const killedCorrectors: Record<string, string[]> = {
      guarded: killedBy(byPolicy.get("guarded")!),
      "guarded-sig": killedBy(byPolicy.get("guarded-sig")!),
    };

    const sweep: SweepRow[] = [];
    for (const limit of SWEEP_LIMITS) {
      const policy = signatureGuardPolicy(limit);
      const outcomes = await runSuite(
        inputs.tasks,
        policy,
        DRIFT_POLICY_INDEX_BASE + policies.length + limit,
        inputs,
        clock,
      );
      sweep.push({
        limit,
        completed: outcomes.filter((o) => o.ok).length,
        correctorsKilled: killedBy(outcomes).length,
        stubbornModelCalls: stubbornSum(outcomes, (o) => o.modelCalls),
        stubbornTokens: stubbornSum(outcomes, (o) => o.tokensIn + o.tokensOut),
        totalTokens: outcomes.reduce((acc, o) => acc + o.tokensIn + o.tokensOut, 0),
      });
    }

    const guardedIndex = POLICIES.findIndex((p) => p.name === "guarded");
    const originalGuarded = await runSuite(
      inputs.originalTasks,
      guarded,
      guardedIndex,
      inputs,
      clock,
    );
    const originalSig = await runSuite(
      inputs.originalTasks,
      signatureGuardPolicy(),
      guardedIndex,
      inputs,
      clock,
    );
    const divergingTaskIds = inputs.originalTasks
      .map((task, i) => {
        const a = originalGuarded[i]!;
        const b = originalSig[i]!;
        const same =
          a.ok === b.ok &&
          a.failReason === b.failReason &&
          a.modelCalls === b.modelCalls &&
          a.tokensIn === b.tokensIn &&
          a.tokensOut === b.tokensOut;
        return same ? undefined : task.id;
      })
      .filter((id): id is string => id !== undefined);
    const originalSuite: OriginalSuiteCheck = {
      tasks: inputs.originalTasks.length,
      guardedCompleted: originalGuarded.filter((o) => o.ok).length,
      sigCompleted: originalSig.filter((o) => o.ok).length,
      divergingTaskIds,
    };

    return {
      perPolicy,
      perCategory,
      stubbornTasks: stubbornIdx.length,
      stubbornDrift,
      killedCorrectors,
      sweep,
      originalSuite,
    };
  })();
  return clock.runUntil(done);
}
