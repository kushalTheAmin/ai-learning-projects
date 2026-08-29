/**
 * Entry point: score every scripted extractor under every metric configuration
 * and print the tables the README quotes.
 */

import { INVOICES } from "./dataset.js";
import { countLeaves, macroF1, microMetrics } from "./compare.js";
import { LADDER, FULL, STRICT } from "./normalize.js";
import {
  BASE_SEED,
  exactMatchRate,
  fmt,
  pad,
  padLeft,
  prfCells,
  runExtractors,
  scoreRun,
} from "./report.js";
import type { JsonValue } from "./json.js";

const runs = runExtractors();
const goldLeaves = INVOICES.reduce((n, inv) => n + countLeaves(inv as unknown as JsonValue), 0);

console.log(`dataset: ${INVOICES.length} gold invoices, ${goldLeaves} gold leaves, seed ${BASE_SEED}`);
console.log();

console.log("== exact match vs field-level scoring ==");
console.log("strict = L0 exact values + index-aligned arrays; semantic = L3 normalization + greedy alignment");
console.log();
console.log(
  `${pad("extractor", 14)} ${padLeft("exact", 6)}   ${pad("strict P      R      F1", 24)}  ${pad("semantic P    R      F1", 24)} ${padLeft("macroF1", 8)}`,
);
for (const run of runs) {
  const strict = scoreRun(run, STRICT, "index");
  const semantic = scoreRun(run, FULL, "aligned");
  const semMacro = macroF1(semantic.perPath).macroF1;
  console.log(
    `${pad(run.extractor.name, 14)} ${padLeft(fmt(exactMatchRate(run)), 6)}   ${prfCells(microMetrics(strict.total))}      ${prfCells(microMetrics(semantic.total))}   ${padLeft(fmt(semMacro), 6)}`,
  );
}
console.log();

console.log("== normalization ladder (greedy-aligned arrays, micro F1) ==");
console.log();
console.log(`${pad("extractor", 14)} ${LADDER.map((l) => padLeft(l.name, 10)).join("  ")}`);
for (const run of runs) {
  const cells = LADDER.map((level) => padLeft(fmt(microMetrics(scoreRun(run, level.options, "aligned").total).f1), 10));
  console.log(`${pad(run.extractor.name, 14)} ${cells.join("  ")}`);
}
console.log();

console.log("== array alignment policy (L3 normalization, micro F1) ==");
console.log();
console.log(`${pad("extractor", 14)} ${padLeft("index", 8)} ${padLeft("aligned", 8)} ${padLeft("delta", 8)}`);
for (const run of runs) {
  const byIndex = microMetrics(scoreRun(run, FULL, "index").total).f1;
  const aligned = microMetrics(scoreRun(run, FULL, "aligned").total).f1;
  console.log(
    `${pad(run.extractor.name, 14)} ${padLeft(fmt(byIndex), 8)} ${padLeft(fmt(aligned), 8)} ${padLeft(fmt(aligned - byIndex), 8)}`,
  );
}
console.log();

console.log("== per-field breakdown: tax-bungler (semantic scoring) ==");
console.log("micro F1 shrugs at one broken field; the per-path table names it");
console.log();
const bungler = runs.find((r) => r.extractor.name === "tax-bungler");
if (bungler === undefined) throw new Error("tax-bungler missing from extractor roster");
const bunglerResult = scoreRun(bungler, FULL, "aligned");
const bunglerMicro = microMetrics(bunglerResult.total);
console.log(`micro F1 ${fmt(bunglerMicro.f1)}, macro F1 ${fmt(macroF1(bunglerResult.perPath).macroF1)}`);
console.log();
console.log(`${pad("field path", 26)} ${padLeft("P", 6)} ${padLeft("R", 6)} ${padLeft("F1", 6)}`);
for (const [path, tally] of bunglerResult.perPath) {
  const m = microMetrics(tally);
  console.log(`${pad(path, 26)} ${padLeft(fmt(m.precision), 6)} ${padLeft(fmt(m.recall), 6)} ${padLeft(fmt(m.f1), 6)}`);
}
console.log();

console.log("== per-field breakdown: lazy (semantic scoring), rows with F1 < 1 ==");
console.log();
const lazy = runs.find((r) => r.extractor.name === "lazy");
if (lazy === undefined) throw new Error("lazy missing from extractor roster");
const lazyResult = scoreRun(lazy, FULL, "aligned");
console.log(`micro F1 ${fmt(microMetrics(lazyResult.total).f1)}, macro F1 ${fmt(macroF1(lazyResult.perPath).macroF1)}`);
console.log();
console.log(`${pad("field path", 26)} ${padLeft("P", 6)} ${padLeft("R", 6)} ${padLeft("F1", 6)}`);
for (const [path, tally] of lazyResult.perPath) {
  const m = microMetrics(tally);
  if (m.f1 < 1) {
    console.log(`${pad(path, 26)} ${padLeft(fmt(m.precision), 6)} ${padLeft(fmt(m.recall), 6)} ${padLeft(fmt(m.f1), 6)}`);
  }
}
