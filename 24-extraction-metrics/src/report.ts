/**
 * Scoring runs and plain-text tables. Everything here is deterministic:
 * same seed, same dataset, same numbers.
 */

import { INVOICES } from "./dataset.js";
import { EXTRACTORS, extractorRng, type Extractor } from "./extractors.js";
import {
  compare,
  macroF1,
  mergeResults,
  microMetrics,
  type ArrayPolicy,
  type ComparisonResult,
  type Prf,
} from "./compare.js";
import { deepEqual, type JsonValue } from "./json.js";
import type { CompareOptions } from "./normalize.js";

export const BASE_SEED = 42;

export interface ExtractorRun {
  extractor: Extractor;
  /** One predicted tree per gold record, in dataset order. */
  predictions: JsonValue[];
}

/** Materialize every extractor's predictions once; every scoring config reuses them. */
export function runExtractors(baseSeed: number = BASE_SEED): ExtractorRun[] {
  return EXTRACTORS.map((extractor, ei) => ({
    extractor,
    predictions: INVOICES.map((inv, ri) => extractor.run(inv, extractorRng(baseSeed, ei, ri))),
  }));
}

export function scoreRun(run: ExtractorRun, opts: CompareOptions, policy: ArrayPolicy): ComparisonResult {
  const merged: ComparisonResult = {
    total: { correct: 0, wrong: 0, missing: 0, spurious: 0 },
    perPath: new Map(),
  };
  run.predictions.forEach((pred, i) => {
    mergeResults(merged, compare(INVOICES[i] as unknown as JsonValue, pred, opts, policy));
  });
  return merged;
}

/** Fraction of records where the prediction strictly deep-equals the gold record. */
export function exactMatchRate(run: ExtractorRun): number {
  const hits = run.predictions.filter((pred, i) => deepEqual(INVOICES[i] as unknown as JsonValue, pred)).length;
  return hits / run.predictions.length;
}

export function fmt(n: number): string {
  return n.toFixed(3);
}

export function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

export function padLeft(s: string, width: number): string {
  return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

export function prfCells(p: Prf): string {
  return `${fmt(p.precision)}  ${fmt(p.recall)}  ${fmt(p.f1)}`;
}

export function summaryLine(result: ComparisonResult): { micro: Prf; macro: number } {
  return { micro: microMetrics(result.total), macro: macroF1(result.perPath).macroF1 };
}
