/**
 * Field-level comparison of a predicted JSON tree against a gold tree.
 *
 * Every gold leaf ends up exactly one of: correct, wrong-value, missing.
 * Every predicted leaf ends up exactly one of: correct, wrong-value, spurious.
 * A wrong-value pairs one gold leaf with one predicted leaf at the same slot.
 * From those four counts:
 *
 *   precision = correct / (correct + wrong + spurious)   (predicted leaves)
 *   recall    = correct / (correct + wrong + missing)    (gold leaves)
 *
 * so hallucinated fields cost precision, dropped fields cost recall, and a
 * present-but-wrong field costs both.
 */

import {
  countLeaves,
  flatten,
  genericPath,
  isArray,
  isObject,
  isPrimitive,
  type JsonValue,
  type PathSegment,
} from "./json.js";
import { valuesMatch, type CompareOptions } from "./normalize.js";

/** How array elements are lined up before element-by-element comparison. */
export type ArrayPolicy = "index" | "aligned";

export interface Tally {
  correct: number;
  wrong: number;
  missing: number;
  spurious: number;
}

export interface ComparisonResult {
  total: Tally;
  /** Per generic path (array indices collapsed to []), document order of first sighting. */
  perPath: Map<string, Tally>;
}

function emptyTally(): Tally {
  return { correct: 0, wrong: 0, missing: 0, spurious: 0 };
}

function pathTally(result: ComparisonResult, segments: PathSegment[]): Tally {
  const key = genericPath(segments);
  let tally = result.perPath.get(key);
  if (tally === undefined) {
    tally = emptyTally();
    result.perPath.set(key, tally);
  }
  return tally;
}

function record(result: ComparisonResult, segments: PathSegment[], kind: keyof Tally, n = 1): void {
  if (n === 0) return;
  result.total[kind] += n;
  pathTally(result, segments)[kind] += n;
}

/** Charge a whole subtree as missing (gold-only) or spurious (pred-only), leaf by leaf. */
function chargeSubtree(
  result: ComparisonResult,
  value: JsonValue,
  segments: PathSegment[],
  kind: "missing" | "spurious",
): void {
  for (const leaf of flatten(value, segments)) {
    record(result, leaf.segments, kind);
  }
}

export function compare(
  gold: JsonValue,
  pred: JsonValue,
  opts: CompareOptions,
  arrayPolicy: ArrayPolicy,
): ComparisonResult {
  const result: ComparisonResult = { total: emptyTally(), perPath: new Map() };
  compareInto(result, gold, pred, [], opts, arrayPolicy);
  return result;
}

function compareInto(
  result: ComparisonResult,
  gold: JsonValue,
  pred: JsonValue,
  segments: PathSegment[],
  opts: CompareOptions,
  arrayPolicy: ArrayPolicy,
): void {
  if (isPrimitive(gold) && isPrimitive(pred)) {
    record(result, segments, valuesMatch(gold, pred, opts) ? "correct" : "wrong");
    return;
  }
  if (isObject(gold) && isObject(pred)) {
    // Own properties only: `in` walks the prototype chain, so a document field
    // named `toString` or `constructor` would read as present on an object that
    // never had it, and the leaf would be scored against Object.prototype.
    for (const key of Object.keys(gold)) {
      const childPath = [...segments, key];
      if (Object.hasOwn(pred, key)) {
        compareInto(result, gold[key] as JsonValue, pred[key] as JsonValue, childPath, opts, arrayPolicy);
      } else {
        chargeSubtree(result, gold[key] as JsonValue, childPath, "missing");
      }
    }
    for (const key of Object.keys(pred)) {
      if (!Object.hasOwn(gold, key)) {
        chargeSubtree(result, pred[key] as JsonValue, [...segments, key], "spurious");
      }
    }
    return;
  }
  if (isArray(gold) && isArray(pred)) {
    compareArrays(result, gold, pred, segments, opts, arrayPolicy);
    return;
  }
  // Structural type mismatch (object where a string was expected, etc.):
  // the gold subtree was not produced, the predicted subtree is not asked for.
  chargeSubtree(result, gold, segments, "missing");
  chargeSubtree(result, pred, segments, "spurious");
}

function compareArrays(
  result: ComparisonResult,
  gold: JsonValue[],
  pred: JsonValue[],
  segments: PathSegment[],
  opts: CompareOptions,
  arrayPolicy: ArrayPolicy,
): void {
  const pairs =
    arrayPolicy === "index"
      ? gold.slice(0, Math.min(gold.length, pred.length)).map((_, i) => [i, i] as const)
      : alignArrays(gold, pred, opts);
  const goldUsed = new Set<number>();
  const predUsed = new Set<number>();
  for (const [gi, pi] of pairs) {
    goldUsed.add(gi);
    predUsed.add(pi);
    compareInto(result, gold[gi] as JsonValue, pred[pi] as JsonValue, [...segments, gi], opts, arrayPolicy);
  }
  gold.forEach((item, gi) => {
    if (!goldUsed.has(gi)) chargeSubtree(result, item, [...segments, gi], "missing");
  });
  pred.forEach((item, pi) => {
    if (!predUsed.has(pi)) chargeSubtree(result, item, [...segments, pi], "spurious");
  });
}

/**
 * Greedy order-insensitive alignment: score every (gold, pred) element pair by
 * its own field-level F1, then take pairs best-first. Ties break on (gold
 * index, pred index) so the result is deterministic, and identical duplicate
 * elements pair off in document order. Every element pairs at most once;
 * leftover elements are charged whole as missing or spurious by the caller.
 * Zero-score pairs still pair when slots remain: their leaves become wrong
 * values, which charges the same denominators as missing + spurious would.
 */
export function alignArrays(
  gold: JsonValue[],
  pred: JsonValue[],
  opts: CompareOptions,
): (readonly [number, number])[] {
  const scored: { gi: number; pi: number; f1: number }[] = [];
  gold.forEach((g, gi) => {
    pred.forEach((p, pi) => {
      // Element pairs are scored with index policy inside: alignment of nested
      // arrays would recurse forever chasing its own score otherwise.
      const r = compare(g, p, opts, "index");
      scored.push({ gi, pi, f1: microMetrics(r.total).f1 });
    });
  });
  scored.sort((a, b) => b.f1 - a.f1 || a.gi - b.gi || a.pi - b.pi);
  const goldUsed = new Set<number>();
  const predUsed = new Set<number>();
  const pairs: (readonly [number, number])[] = [];
  for (const { gi, pi } of scored) {
    if (goldUsed.has(gi) || predUsed.has(pi)) continue;
    goldUsed.add(gi);
    predUsed.add(pi);
    pairs.push([gi, pi] as const);
  }
  pairs.sort((a, b) => a[0] - b[0]);
  return pairs;
}

export interface Prf {
  precision: number;
  recall: number;
  f1: number;
}

/**
 * Micro metrics over a tally. Conventions: an empty gold with an empty
 * prediction is a perfect extraction (1.0 across the board); an empty
 * denominator on one side only scores 0 there.
 */
export function microMetrics(t: Tally): Prf {
  const predLeaves = t.correct + t.wrong + t.spurious;
  const goldLeaves = t.correct + t.wrong + t.missing;
  if (predLeaves === 0 && goldLeaves === 0) return { precision: 1, recall: 1, f1: 1 };
  const precision = predLeaves === 0 ? 0 : t.correct / predLeaves;
  const recall = goldLeaves === 0 ? 0 : t.correct / goldLeaves;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

/**
 * Macro F1: unweighted mean of per-path F1 over the paths that exist in gold
 * (a path with any gold leaf). Paths that only ever appear in predictions are
 * hallucinated structure; they already cost micro precision, and they are
 * reported, not averaged, because they have no gold side to recall.
 */
export function macroF1(perPath: Map<string, Tally>): { macroF1: number; goldPaths: number } {
  let sum = 0;
  let n = 0;
  for (const tally of perPath.values()) {
    if (tally.correct + tally.wrong + tally.missing === 0) continue;
    sum += microMetrics(tally).f1;
    n += 1;
  }
  return { macroF1: n === 0 ? 1 : sum / n, goldPaths: n };
}

/** Merge b into a, path by path. */
export function mergeResults(a: ComparisonResult, b: ComparisonResult): void {
  for (const kind of ["correct", "wrong", "missing", "spurious"] as const) {
    a.total[kind] += b.total[kind];
  }
  for (const [path, tally] of b.perPath) {
    let target = a.perPath.get(path);
    if (target === undefined) {
      target = emptyTally();
      a.perPath.set(path, target);
    }
    for (const kind of ["correct", "wrong", "missing", "spurious"] as const) {
      target[kind] += tally[kind];
    }
  }
}

export { countLeaves };
