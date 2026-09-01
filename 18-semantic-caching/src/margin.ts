/**
 * The serve-margin study. Two questions, both about the runner-up entry at
 * serve time. First: at margin 0, does the gap between the best entry and
 * its closest differing-answer competitor actually separate right serves
 * from wrong ones — is the gap a signal at all? Second: when the cache
 * refuses to serve inside the margin, what does that buy (wrong serves
 * avoided) and what does it cost (right serves sent back to the model)?
 * Every margin row is a live replay: a refusal becomes a model call and an
 * insert, so a margined cache builds a different store than the margin-0
 * cache and no offline projection over a margin-0 capture is honest.
 */

import { rocAuc } from "../../20-guardrails/src/metrics.js";
import type { MarginPolicy } from "./cache.js";
import type { Featurizer } from "./features.js";
import { runReplay, type ReplayResult, type ServeRecord } from "./replay.js";
import type { TrafficRequest } from "./traffic.js";

export interface GapSideStats {
  serves: number;
  /** Serves with no differing-answer entry stored — a margin can never refuse these. */
  noCompetitor: number;
  gapMean: number;
  gapMedian: number;
  gapMin: number;
  gapMax: number;
}

export interface GapStudy {
  label: string;
  threshold: number;
  right: GapSideStats;
  wrong: GapSideStats;
  /**
   * ROC-AUC of the differing-answer gap separating right serves from wrong
   * ones, over serves that have a competitor. Above 0.5 means right serves
   * sit on bigger gaps, so some margin can trade wrong serves for right
   * ones at better than chance.
   */
  auc: number;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const upper = sorted[mid];
  if (upper === undefined) return 0;
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[mid - 1];
  return lower === undefined ? upper : (lower + upper) / 2;
}

function sideStats(records: readonly ServeRecord[]): { stats: GapSideStats; gaps: number[] } {
  const gaps: number[] = [];
  let noCompetitor = 0;
  for (const record of records) {
    if (record.competitorDiffering === undefined) noCompetitor++;
    else gaps.push(record.similarity - record.competitorDiffering);
  }
  if (gaps.length === 0) {
    return {
      stats: { serves: records.length, noCompetitor, gapMean: 0, gapMedian: 0, gapMin: 0, gapMax: 0 },
      gaps,
    };
  }
  let sum = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const gap of gaps) {
    sum += gap;
    if (gap < min) min = gap;
    if (gap > max) max = gap;
  }
  return {
    stats: {
      serves: records.length,
      noCompetitor,
      gapMean: sum / gaps.length,
      gapMedian: median(gaps),
      gapMin: min,
      gapMax: max,
    },
    gaps,
  };
}

/** Replay at margin 0 and study the gap every semantic serve carried. */
export function gapStudy(
  traffic: readonly TrafficRequest[],
  featurizer: Featurizer,
  threshold: number,
): GapStudy {
  const records: ServeRecord[] = [];
  runReplay(traffic, featurizer, threshold, featurizer.name, undefined, (record) =>
    records.push(record),
  );
  const right = sideStats(records.filter((record) => record.right));
  const wrong = sideStats(records.filter((record) => !record.right));
  return {
    label: featurizer.name,
    threshold,
    right: right.stats,
    wrong: wrong.stats,
    auc: rocAuc(right.gaps, wrong.gaps),
  };
}

export interface MarginRow {
  label: string;
  threshold: number;
  margin: number;
  scope: MarginPolicy["scope"] | "none";
  result: ReplayResult;
}

/** Live replays over a margin sweep at one threshold; margin 0 is the baseline row. */
export function marginSweep(
  traffic: readonly TrafficRequest[],
  featurizer: Featurizer,
  threshold: number,
  margins: readonly number[],
  scopes: readonly MarginPolicy["scope"][],
): MarginRow[] {
  const rows: MarginRow[] = [
    {
      label: featurizer.name,
      threshold,
      margin: 0,
      scope: "none",
      result: runReplay(traffic, featurizer, threshold, featurizer.name),
    },
  ];
  for (const scope of scopes) {
    for (const margin of margins) {
      const policy: MarginPolicy = { margin, scope };
      rows.push({
        label: featurizer.name,
        threshold,
        margin,
        scope,
        result: runReplay(traffic, featurizer, threshold, featurizer.name, policy),
      });
    }
  }
  return rows;
}

/**
 * Wrong serves across the threshold sweep at one fixed margin policy. The
 * original sweep found wrong serves non-monotone in the threshold because
 * the store is policy-dependent; this measures whether a margin restores
 * the monotone story a tuner would like to assume.
 */
export function thresholdSweepUnderMargin(
  traffic: readonly TrafficRequest[],
  featurizer: Featurizer,
  thresholds: readonly number[],
  marginPolicy: MarginPolicy | undefined,
): ReplayResult[] {
  return thresholds.map((threshold) =>
    runReplay(traffic, featurizer, threshold, featurizer.name, marginPolicy),
  );
}

/**
 * Adjacent threshold pairs (ascending) where wrong serves rise as the
 * threshold rises — 0 means the sweep is monotone the way pair statistics
 * would predict.
 */
export function monotonicityViolations(wrongByAscendingThreshold: readonly number[]): number {
  let violations = 0;
  for (let i = 0; i + 1 < wrongByAscendingThreshold.length; i++) {
    const here = wrongByAscendingThreshold[i];
    const next = wrongByAscendingThreshold[i + 1];
    if (here !== undefined && next !== undefined && next > here) violations++;
  }
  return violations;
}
