/**
 * The full harness: every judge through every measurement, all seeded. The
 * result object is what main.ts prints and what the integration tests pin.
 */

import {
  buildDataset,
  better,
  worse,
  type Dataset,
  type Pair,
  type Slot,
} from "./dataset.js";
import { gradePointwise, JUDGES, type JudgeSpec } from "./judge.js";
import {
  runPairs,
  type CallCost,
  type PairProtocol,
  type ProtocolRun,
} from "./protocols.js";
import { accuracy, cohensKappa, decidedStats, rate } from "./metrics.js";

export const DEFAULT_SEED = 7;

export interface PointwiseRow {
  judge: string;
  passRate: number;
  accuracy: number;
  kappa: number;
}

export interface PointwiseResult {
  goldPassRate: number;
  rows: PointwiseRow[];
  /** Degenerate baseline: a judge that passes everything. */
  alwaysPass: PointwiseRow;
}

export interface CoreRow {
  judge: string;
  asStoredAccuracy: number;
  randomizedAccuracy: number;
  /** both-order: fraction of pairs whose two calls named different winners. */
  flipRate: number;
  coverage: number;
  decidedAccuracy: number;
  effectiveAccuracy: number;
}

export interface WinRateRow {
  judge: string;
  /** Single-call protocol named by the experiment (champion-first or randomized). */
  singleOrder: number;
  /** both-order with abstentions counted half. */
  bothOrder: number;
}

export interface ChampionRow {
  judge: string;
  /** One call per pair with the incumbent always in the first slot. */
  championFirst: number;
  /** One call per pair with the presentation order drawn per pair. */
  randomized: number;
  /** Two calls per pair, abstentions counted half. */
  bothOrder: number;
}

export interface LengthRow {
  judge: string;
  /** Win rate of the longer answer under randomized order; gold is 0.5. */
  longerWinRate: number;
  accuracyLongerBetter: number;
  accuracyShorterBetter: number;
}

export interface CostRow {
  protocol: PairProtocol;
  callsPerPair: number;
  tokensInPer1k: number;
  tokensOutPer1k: number;
  usdPer1k: number;
}

export interface ExperimentResult {
  seed: number;
  pointwise: PointwiseResult;
  core: CoreRow[];
  /** Challenger win rate, true value 0.5, under each of the three protocols. */
  champion: ChampionRow[];
  /** House win rate, true value 0.5, measured under randomized order. */
  house: WinRateRow[];
  length: LengthRow[];
  cost: CostRow[];
}

function goldSlots(pairs: readonly Pair[]): Slot[] {
  return pairs.map((p) => p.gold);
}

function verdictSlots(run: ProtocolRun): (Slot | "abstain")[] {
  return run.verdicts.map((v) => v.verdict);
}

function runPointwise(dataset: Dataset): PointwiseResult {
  const gold = dataset.grading.map((g) => g.goldPass);
  const rows = JUDGES.map((judge) => {
    const pred = dataset.grading.map((g) => gradePointwise(judge, g.id, g.answer));
    return {
      judge: judge.name,
      passRate: rate(pred, (p) => p),
      accuracy: accuracy(gold, pred),
      kappa: cohensKappa(gold, pred),
    };
  });
  const allTrue = gold.map(() => true);
  return {
    goldPassRate: rate(gold, (g) => g),
    rows,
    alwaysPass: {
      judge: "always-pass",
      passRate: 1,
      accuracy: accuracy(gold, allTrue),
      kappa: cohensKappa(gold, allTrue),
    },
  };
}

function runCore(dataset: Dataset, seed: number): CoreRow[] {
  const gold = goldSlots(dataset.corePairs);
  return JUDGES.map((judge) => {
    const stored = runPairs(judge, dataset.corePairs, "as-stored", seed);
    const randomized = runPairs(judge, dataset.corePairs, "randomized", seed);
    const both = runPairs(judge, dataset.corePairs, "both-order", seed);
    const stats = decidedStats(gold, verdictSlots(both));
    return {
      judge: judge.name,
      asStoredAccuracy: accuracy(gold, verdictSlots(stored)),
      randomizedAccuracy: accuracy(gold, verdictSlots(randomized)),
      flipRate: rate(both.verdicts, (v) => v.flipped),
      coverage: stats.coverage,
      decidedAccuracy: stats.decidedAccuracy,
      effectiveAccuracy: stats.effectiveAccuracy,
    };
  });
}

/** Win rate of `slot`, counting an abstention as half a win. */
function slotWinRate(run: ProtocolRun, slot: Slot): number {
  let wins = 0;
  for (const v of run.verdicts) {
    if (v.verdict === slot) wins += 1;
    else if (v.verdict === "abstain") wins += 0.5;
  }
  return wins / run.verdicts.length;
}

function runChampion(dataset: Dataset, seed: number): ChampionRow[] {
  // Slot a is the incumbent; as-stored is exactly the champion-first layout.
  // Randomized is the debiasing move the cheap protocol offers, so it is
  // measured here rather than read off the both-order column.
  return JUDGES.map((judge) => ({
    judge: judge.name,
    championFirst: slotWinRate(runPairs(judge, dataset.championPairs, "as-stored", seed), "b"),
    randomized: slotWinRate(runPairs(judge, dataset.championPairs, "randomized", seed), "b"),
    bothOrder: slotWinRate(runPairs(judge, dataset.championPairs, "both-order", seed), "b"),
  }));
}

/** Win rate of the house answer, abstentions counted half. */
function houseWinRate(pairs: readonly Pair[], run: ProtocolRun): number {
  let wins = 0;
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i]!;
    const houseSlot: Slot = pair.a.provenance === "house" ? "a" : "b";
    const verdict = run.verdicts[i]!.verdict;
    if (verdict === houseSlot) wins += 1;
    else if (verdict === "abstain") wins += 0.5;
  }
  return wins / pairs.length;
}

function runHouse(dataset: Dataset, seed: number): WinRateRow[] {
  return JUDGES.map((judge) => ({
    judge: judge.name,
    singleOrder: houseWinRate(
      dataset.housePairs,
      runPairs(judge, dataset.housePairs, "randomized", seed),
    ),
    bothOrder: houseWinRate(
      dataset.housePairs,
      runPairs(judge, dataset.housePairs, "both-order", seed),
    ),
  }));
}

function runLength(dataset: Dataset, seed: number): LengthRow[] {
  const pairs = dataset.lengthPairs;
  const longerBetter = pairs.filter((p) => better(p).tokens > worse(p).tokens);
  const shorterBetter = pairs.filter((p) => better(p).tokens < worse(p).tokens);
  return JUDGES.map((judge) => {
    const run = runPairs(judge, pairs, "randomized", seed);
    const bySplit = (subset: readonly Pair[]): number => {
      const ids = new Set(subset.map((p) => p.id));
      const gold = subset.map((p) => p.gold);
      const verdicts = run.verdicts
        .filter((v) => ids.has(v.pairId))
        .map((v) => v.verdict);
      return accuracy(gold, verdicts);
    };
    let longerWins = 0;
    for (let i = 0; i < pairs.length; i++) {
      const pair = pairs[i]!;
      const longerSlot: Slot = pair.a.tokens > pair.b.tokens ? "a" : "b";
      if (run.verdicts[i]!.verdict === longerSlot) longerWins++;
    }
    return {
      judge: judge.name,
      longerWinRate: longerWins / pairs.length,
      accuracyLongerBetter: bySplit(longerBetter),
      accuracyShorterBetter: bySplit(shorterBetter),
    };
  });
}

function runCost(dataset: Dataset, seed: number, judge: JudgeSpec): CostRow[] {
  const protocols: PairProtocol[] = ["as-stored", "randomized", "both-order"];
  return protocols.map((protocol) => {
    const cost: CallCost = runPairs(judge, dataset.corePairs, protocol, seed).cost;
    const pairCount = dataset.corePairs.length;
    const scale = 1000 / pairCount;
    return {
      protocol,
      callsPerPair: cost.calls / pairCount,
      tokensInPer1k: Math.round(cost.tokensIn * scale),
      tokensOutPer1k: Math.round(cost.tokensOut * scale),
      usdPer1k: cost.costUsd * scale,
    };
  });
}

export function runExperiment(seed: number = DEFAULT_SEED): ExperimentResult {
  const dataset = buildDataset(seed);
  return {
    seed,
    pointwise: runPointwise(dataset),
    core: runCore(dataset, seed),
    champion: runChampion(dataset, seed),
    house: runHouse(dataset, seed),
    length: runLength(dataset, seed),
    cost: runCost(dataset, seed, JUDGES[0]!),
  };
}
