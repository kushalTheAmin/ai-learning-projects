/**
 * The flaky-poison study: sweep flake rate and flaky-item count, run every
 * recovery strategy over many seeded trials, and find where bisect stops
 * beating one-by-one.
 *
 * A single trial of a probabilistic failure is a sample, not a measurement,
 * so every cell is a mean over `trials` independently seeded runs. Trial
 * seeds are shared across strategies within a config, which pairs the first
 * call exactly: in trials where it passes, all four strategies see the
 * identical one-call outcome, and every difference in the table comes from
 * the trials where the first call failed (the `1st fail` column says how
 * many those were).
 */
import { VirtualClock } from "../../06-rate-limiting/src/clock.js";
import { createRng } from "../../05-token-streaming/src/rng.js";
import { SimulatedApi } from "./api.js";
import type { WorkItem } from "./api.js";
import { DEFAULT_SEED } from "./experiment.js";
import { ISOLATION_STRATEGIES } from "./isolate.js";
import type { IsolationStrategy } from "./isolate.js";
import { runFlakyRecovery } from "./flaky.js";

export interface FlakyStudyConfig {
  seed: number;
  batchSize: number;
  trials: number;
  maxRetries: number;
  flakyCounts: readonly number[];
  flakeRates: readonly number[];
}

export const FLAKY_STUDY: FlakyStudyConfig = {
  seed: DEFAULT_SEED,
  batchSize: 32,
  trials: 250,
  maxRetries: 3,
  flakyCounts: [1, 4],
  flakeRates: [0.1, 0.3, 0.5, 0.7, 0.9],
};

export interface FlakyRow {
  flakyCount: number;
  flakeRate: number;
  strategy: IsolationStrategy;
  /** Fraction of trials whose first whole-batch call was rejected. */
  firstCallFailedPct: number;
  meanCalls: number;
  meanInputTokens: number;
  /** Mean fraction of never-flaky items that completed. */
  healthyCompletedPct: number;
  /** Mean fraction of flaky items that completed. */
  flakyCompletedPct: number;
  meanElapsedMs: number;
}

/** Spread `count` flaky ids evenly across a batch, mirroring the original
 * study's spaced poison sets. */
export function spreadFlakyIds(batchSize: number, count: number): number[] {
  if (count < 0 || count > batchSize) {
    throw new Error(`cannot place ${count} flaky items in a batch of ${batchSize}`);
  }
  return Array.from({ length: count }, (_, i) => Math.floor(((i + 0.5) * batchSize) / count));
}

export function makeFlakyItems(
  batchSize: number,
  flakyIds: readonly number[],
  flakeRate: number,
): WorkItem[] {
  if (!Number.isFinite(flakeRate) || flakeRate < 0 || flakeRate > 1) {
    throw new Error(`flakeRate must sit in [0, 1], got ${flakeRate}`);
  }
  const flaky = new Set(flakyIds);
  return Array.from({ length: batchSize }, (_, id) => ({
    id,
    poisoned: false,
    flakeRate: flaky.has(id) ? flakeRate : 0,
  }));
}

export async function runFlakyStudy(cfg: FlakyStudyConfig = FLAKY_STUDY): Promise<FlakyRow[]> {
  const rows: FlakyRow[] = [];
  let cfgIndex = 0;
  for (const flakyCount of cfg.flakyCounts) {
    for (const flakeRate of cfg.flakeRates) {
      const flakyIds = spreadFlakyIds(cfg.batchSize, flakyCount);
      const flakySet = new Set(flakyIds);
      const healthyCount = cfg.batchSize - flakyCount;
      // One seed list per config, shared across strategies, so the first
      // call of trial t is the same draw for all four.
      const seeder = createRng(cfg.seed + 7919 * cfgIndex);
      const trialSeeds = Array.from({ length: cfg.trials }, () =>
        Math.floor(seeder() * 4294967296),
      );
      for (const strategy of ISOLATION_STRATEGIES) {
        let firstCallFailed = 0;
        let calls = 0;
        let inputTokens = 0;
        let healthyDone = 0;
        let flakyDone = 0;
        let elapsedMs = 0;
        for (const trialSeed of trialSeeds) {
          const clock = new VirtualClock();
          const api = new SimulatedApi(
            clock,
            createRng(trialSeed),
            {},
            createRng(trialSeed ^ 0x5f356495),
          );
          const items = makeFlakyItems(cfg.batchSize, flakyIds, flakeRate);
          const outcome = await clock.runUntil(
            runFlakyRecovery(api, clock, items, strategy, cfg.maxRetries),
          );
          if (!(outcome.calls === 1 && outcome.completed.length === cfg.batchSize)) {
            firstCallFailed++;
          }
          calls += outcome.calls;
          inputTokens += outcome.inputTokens;
          for (const result of outcome.completed) {
            if (flakySet.has(result.id)) flakyDone++;
            else healthyDone++;
          }
          elapsedMs += outcome.elapsedMs;
        }
        const t = cfg.trials;
        rows.push({
          flakyCount,
          flakeRate,
          strategy,
          firstCallFailedPct: (firstCallFailed / t) * 100,
          meanCalls: calls / t,
          meanInputTokens: inputTokens / t,
          healthyCompletedPct: (healthyDone / (t * healthyCount)) * 100,
          flakyCompletedPct: flakyCount === 0 ? 100 : (flakyDone / (t * flakyCount)) * 100,
          meanElapsedMs: elapsedMs / t,
        });
      }
      cfgIndex++;
    }
  }
  return rows;
}

export interface CrossoverRow {
  flakyCount: number;
  flakeRate: number;
  callsRatio: number;
  tokensRatio: number;
}

/** bisect / one-by-one mean cost per config; a ratio above 1 means bisect
 * lost that currency. */
export function crossover(rows: readonly FlakyRow[]): CrossoverRow[] {
  const byConfig = new Map<string, Partial<Record<IsolationStrategy, FlakyRow>>>();
  for (const row of rows) {
    const key = `${row.flakyCount}|${row.flakeRate}`;
    const entry = byConfig.get(key) ?? {};
    entry[row.strategy] = row;
    byConfig.set(key, entry);
  }
  const out: CrossoverRow[] = [];
  for (const entry of byConfig.values()) {
    const bisect = entry.bisect;
    const oneByOne = entry["one-by-one"];
    if (bisect === undefined || oneByOne === undefined) continue;
    out.push({
      flakyCount: bisect.flakyCount,
      flakeRate: bisect.flakeRate,
      callsRatio: bisect.meanCalls / oneByOne.meanCalls,
      tokensRatio: bisect.meanInputTokens / oneByOne.meanInputTokens,
    });
  }
  return out;
}
