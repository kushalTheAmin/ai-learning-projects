/**
 * Entry point: validates the dataset, prints the pair-class similarity
 * analysis for both featurizers, then replays the seeded traffic through
 * the cache at every threshold and prices the whole tradeoff.
 */

import { INTENTS, validateDataset } from "./dataset.js";
import { FEATURIZERS } from "./features.js";
import {
  gapStudy,
  marginSweep,
  monotonicityViolations,
  thresholdSweepUnderMargin,
} from "./margin.js";
import { buildPairs, classStats, inversionRate, operatingTable, similarities } from "./pairs.js";
import {
  noCacheCost,
  runReplay,
  seedSpread,
  SPREAD_CONFIGS,
  SPREAD_SEEDS,
  type ReplayResult,
} from "./replay.js";
import { DEFAULT_TRAFFIC, generateTraffic } from "./traffic.js";

const THRESHOLDS = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95] as const;

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function money(value: number): string {
  return `$${value.toFixed(4)}`;
}

function pad(text: string, width: number): string {
  return text.padStart(width);
}

function printReplayRow(result: ReplayResult): void {
  const hits = result.exactHits + result.semanticCorrect + result.semanticWrong;
  console.log(
    [
      result.label.padEnd(12),
      pad(Number.isFinite(result.threshold) ? result.threshold.toFixed(2) : "-", 6),
      pad(String(result.llmCalls), 6),
      pad(pct(hits / result.requests), 8),
      pad(String(result.exactHits), 6),
      pad(String(result.semanticCorrect), 7),
      pad(String(result.semanticWrong), 6),
      pad(result.wrongPer1k.toFixed(1), 8),
      pad(money(result.costUsd), 9),
      pad(pct(result.savedVsNoCache), 7),
    ].join("  "),
  );
}

function main(): void {
  validateDataset(INTENTS);
  const traffic = generateTraffic(DEFAULT_TRAFFIC);
  const typoedCount = traffic.filter((request) => request.typoed).length;
  const pairs = buildPairs(INTENTS);

  console.log("semantic caching: threshold sweep on labeled support traffic");
  console.log(
    `intents=${INTENTS.length}  requests=${traffic.length}  seed=${DEFAULT_TRAFFIC.seed}  ` +
      `zipf=${DEFAULT_TRAFFIC.zipfExponent}  typoed=${typoedCount}`,
  );

  console.log("\n== pair-class similarity by featurizer ==");
  for (const featurizer of FEATURIZERS) {
    const byClass = similarities(pairs, featurizer);
    console.log(`\n[${featurizer.name}]  class        count    mean     min     max`);
    for (const stats of classStats(byClass)) {
      console.log(
        `        ${stats.pairClass.padEnd(12)} ${pad(String(stats.count), 5)}  ` +
          `${pad(stats.mean.toFixed(3), 6)}  ${pad(stats.min.toFixed(3), 6)}  ${pad(stats.max.toFixed(3), 6)}`,
      );
    }
    console.log(`        inversion rate (near-miss above paraphrase): ${pct(inversionRate(byClass))}`);
  }

  console.log("\n== operating points over labeled pairs ==");
  for (const featurizer of FEATURIZERS) {
    const byClass = similarities(pairs, featurizer);
    console.log(`\n[${featurizer.name}]  threshold  trivial-recall  paraphrase-recall  near-miss-fpr`);
    for (const point of operatingTable(byClass, THRESHOLDS)) {
      console.log(
        `        ${pad(point.threshold.toFixed(2), 9)}  ${pad(pct(point.trivialRecall), 14)}  ` +
          `${pad(pct(point.paraphraseRecall), 17)}  ${pad(pct(point.nearMissFpr), 13)}`,
      );
    }
  }

  console.log("\n== traffic replay: cost vs wrong answers ==");
  console.log(`no cache: ${traffic.length} llm calls, cost ${money(noCacheCost(traffic))}`);
  console.log(
    "\nlabel         thresh   calls  hitrate   exact  semokay  wrong  wrong/1k       cost  saved%",
  );
  const first = FEATURIZERS[0];
  if (first === undefined) throw new Error("no featurizers configured");
  printReplayRow(runReplay(traffic, first, Number.POSITIVE_INFINITY, "exact-only"));
  for (const featurizer of FEATURIZERS) {
    for (const threshold of THRESHOLDS) {
      printReplayRow(runReplay(traffic, featurizer, threshold, featurizer.name));
    }
  }

  console.log(
    `\n== the same operating points across ${SPREAD_SEEDS.length} seeds ` +
      `(${SPREAD_SEEDS[0]}..${SPREAD_SEEDS[SPREAD_SEEDS.length - 1]}) ==`,
  );
  console.log("config       wrong-min  wrong-med  wrong-max  wrong-mean  zero-seeds       saved%");
  for (const spread of seedSpread(DEFAULT_TRAFFIC, SPREAD_SEEDS, SPREAD_CONFIGS)) {
    console.log(
      [
        `${spread.label} ${spread.threshold.toFixed(2)}`.padEnd(12),
        pad(String(spread.wrongMin), 9),
        pad(spread.wrongMedian.toFixed(1), 10),
        pad(String(spread.wrongMax), 10),
        pad(spread.wrongMean.toFixed(2), 11),
        pad(`${spread.zeroWrongSeeds}/${SPREAD_SEEDS.length}`, 11),
        pad(`${pct(spread.savedMin)}-${pct(spread.savedMax)}`, 12),
      ].join("  "),
    );
  }

  console.log("\n== typo traffic at threshold 0.75 ==");
  for (const featurizer of FEATURIZERS) {
    const result = runReplay(traffic, featurizer, 0.75, featurizer.name);
    console.log(
      `${featurizer.name}: ${result.semanticHitsOnTypoed} semantic hits on the ${typoedCount} typoed requests ` +
        `(${result.semanticWrong} wrong serves overall)`,
    );
  }

  console.log("\n== serve-gap study at margin 0: the runner-up as a signal ==");
  console.log(
    "gap = best cosine minus best differing-answer cosine at serve time; no-comp serves have no differing-answer entry stored",
  );
  console.log("label  thresh  right(no-comp)  gap-med  gap-min   wrong(no-comp)  gap-med  gap-min     auc");
  for (const featurizer of FEATURIZERS) {
    for (const threshold of [0.5, 0.75]) {
      const study = gapStudy(traffic, featurizer, threshold);
      console.log(
        [
          study.label.padEnd(5),
          pad(threshold.toFixed(2), 6),
          pad(`${study.right.serves}(${study.right.noCompetitor})`, 14),
          pad(study.right.gapMedian.toFixed(3), 8),
          pad(study.right.gapMin.toFixed(3), 8),
          pad(`${study.wrong.serves}(${study.wrong.noCompetitor})`, 15),
          pad(study.wrong.gapMedian.toFixed(3), 8),
          pad(study.wrong.gapMin.toFixed(3), 8),
          pad(study.auc.toFixed(3), 8),
        ].join(" "),
      );
    }
  }

  console.log("\n== margin sweep, live replays (refusals become model calls and inserts) ==");
  const MARGINS = [0.02, 0.05, 0.1, 0.15, 0.2] as const;
  console.log(
    "label  thresh  scope             margin  wrong  refused  ref-right  ref-wrong  saved%",
  );
  for (const featurizer of FEATURIZERS) {
    for (const threshold of [0.5, 0.75]) {
      const rows = marginSweep(traffic, featurizer, threshold, MARGINS, ["all", "differing-answer"]);
      for (const row of rows) {
        console.log(
          [
            row.label.padEnd(5),
            pad(row.threshold.toFixed(2), 6),
            `  ${row.scope.padEnd(16)}`,
            pad(row.margin.toFixed(2), 6),
            pad(String(row.result.semanticWrong), 6),
            pad(String(row.result.marginRefusals), 8),
            pad(String(row.result.refusedRight), 10),
            pad(String(row.result.refusedWrong), 10),
            pad(pct(row.result.savedVsNoCache), 7),
          ].join(" "),
        );
      }
    }
  }

  console.log("\n== wrong serves across the threshold sweep, by margin (differing-answer) ==");
  console.log(`thresholds: ${THRESHOLDS.map((threshold) => threshold.toFixed(2)).join(" ")}`);
  for (const featurizer of FEATURIZERS) {
    for (const margin of [0, 0.05, 0.1]) {
      const policy = margin === 0 ? undefined : { margin, scope: "differing-answer" as const };
      const sweep = thresholdSweepUnderMargin(traffic, featurizer, THRESHOLDS, policy);
      const wrongs = sweep.map((result) => result.semanticWrong);
      console.log(
        `${featurizer.name} margin ${margin.toFixed(2)}: ` +
          `${wrongs.map((wrong) => pad(String(wrong), 4)).join(" ")}  ` +
          `rises=${monotonicityViolations(wrongs)}`,
      );
    }
  }

  const marginSpreadConfigs = [
    {
      featurizer: FEATURIZERS[0]!,
      threshold: 0.75,
      marginPolicy: { margin: 0.05, scope: "differing-answer" as const },
      label: "word m.05",
    },
    {
      featurizer: FEATURIZERS[0]!,
      threshold: 0.75,
      marginPolicy: { margin: 0.1, scope: "differing-answer" as const },
      label: "word m.10",
    },
    {
      featurizer: FEATURIZERS[1]!,
      threshold: 0.75,
      marginPolicy: { margin: 0.1, scope: "differing-answer" as const },
      label: "char m.10",
    },
    {
      featurizer: FEATURIZERS[0]!,
      threshold: 0.5,
      marginPolicy: { margin: 0.1, scope: "differing-answer" as const },
      label: "word m.10",
    },
  ];
  console.log(
    `\n== margin operating points across ${SPREAD_SEEDS.length} seeds (differing-answer scope) ==`,
  );
  console.log("config          wrong-min  wrong-med  wrong-max  wrong-mean  zero-seeds       saved%");
  for (const spread of seedSpread(DEFAULT_TRAFFIC, SPREAD_SEEDS, marginSpreadConfigs)) {
    console.log(
      [
        `${spread.label} ${spread.threshold.toFixed(2)}`.padEnd(15),
        pad(String(spread.wrongMin), 9),
        pad(spread.wrongMedian.toFixed(1), 10),
        pad(String(spread.wrongMax), 10),
        pad(spread.wrongMean.toFixed(2), 11),
        pad(`${spread.zeroWrongSeeds}/${SPREAD_SEEDS.length}`, 11),
        pad(`${pct(spread.savedMin)}-${pct(spread.savedMax)}`, 12),
      ].join("  "),
    );
  }
}

main();
