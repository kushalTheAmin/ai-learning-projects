/**
 * Pair-level analysis, independent of any traffic: how a featurizer scores
 * the four pair classes the cache has to tell apart. Same-intent pairs
 * (trivial wraps, true paraphrases) should score high; cross-intent pairs
 * (near-miss family siblings, unrelated intents) should score low. Whether
 * a threshold exists that separates them is the whole question.
 */

import { INTENTS, phrasings, type Intent } from "./dataset.js";
import { cosine, type Featurizer } from "./features.js";

export type PairClass = "trivial" | "paraphrase" | "near-miss" | "unrelated";

export interface Pair {
  pairClass: PairClass;
  a: string;
  b: string;
}

/**
 * trivial:    canonical vs each filler-wrapped variant, same intent
 * paraphrase: canonical vs each true rewording, same intent
 * near-miss:  every (canonical|trivial) x (canonical|trivial) pair across
 *             sibling intents in one family — the trap pairs
 * unrelated:  canonical vs canonical across different families — control
 */
export function buildPairs(intents: readonly Intent[] = INTENTS): Pair[] {
  const pairs: Pair[] = [];
  for (const intent of intents) {
    for (const variant of intent.trivial) {
      pairs.push({ pairClass: "trivial", a: intent.canonical, b: variant });
    }
    for (const paraphrase of intent.paraphrases) {
      pairs.push({ pairClass: "paraphrase", a: intent.canonical, b: paraphrase });
    }
  }
  for (let i = 0; i < intents.length; i++) {
    for (let j = i + 1; j < intents.length; j++) {
      const left = intents[i];
      const right = intents[j];
      if (left === undefined || right === undefined) continue;
      if (left.family === right.family) {
        for (const a of [left.canonical, ...left.trivial]) {
          for (const b of [right.canonical, ...right.trivial]) {
            pairs.push({ pairClass: "near-miss", a, b });
          }
        }
      } else {
        pairs.push({ pairClass: "unrelated", a: left.canonical, b: right.canonical });
      }
    }
  }
  return pairs;
}

export interface ClassStats {
  pairClass: PairClass;
  count: number;
  mean: number;
  min: number;
  max: number;
}

export function similarities(pairs: readonly Pair[], featurizer: Featurizer): Map<PairClass, number[]> {
  const byClass = new Map<PairClass, number[]>();
  for (const pair of pairs) {
    const similarity = cosine(featurizer.embed(pair.a), featurizer.embed(pair.b));
    const bucket = byClass.get(pair.pairClass);
    if (bucket === undefined) byClass.set(pair.pairClass, [similarity]);
    else bucket.push(similarity);
  }
  return byClass;
}

export function classStats(byClass: Map<PairClass, number[]>): ClassStats[] {
  const order: PairClass[] = ["trivial", "paraphrase", "near-miss", "unrelated"];
  const stats: ClassStats[] = [];
  for (const pairClass of order) {
    const values = byClass.get(pairClass) ?? [];
    if (values.length === 0) {
      stats.push({ pairClass, count: 0, mean: 0, min: 0, max: 0 });
      continue;
    }
    let sum = 0;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const value of values) {
      sum += value;
      if (value < min) min = value;
      if (value > max) max = value;
    }
    stats.push({ pairClass, count: values.length, mean: sum / values.length, min, max });
  }
  return stats;
}

export interface OperatingPoint {
  threshold: number;
  /** Fraction of same-intent trivial pairs at or above the threshold. */
  trivialRecall: number;
  /** Fraction of same-intent paraphrase pairs at or above the threshold. */
  paraphraseRecall: number;
  /** Fraction of cross-intent near-miss pairs at or above the threshold. */
  nearMissFpr: number;
}

function fractionAtOrAbove(values: readonly number[], threshold: number): number {
  if (values.length === 0) return 0;
  let count = 0;
  for (const value of values) if (value >= threshold) count++;
  return count / values.length;
}

export function operatingTable(
  byClass: Map<PairClass, number[]>,
  thresholds: readonly number[],
): OperatingPoint[] {
  const trivial = byClass.get("trivial") ?? [];
  const paraphrase = byClass.get("paraphrase") ?? [];
  const nearMiss = byClass.get("near-miss") ?? [];
  return thresholds.map((threshold) => ({
    threshold,
    trivialRecall: fractionAtOrAbove(trivial, threshold),
    paraphraseRecall: fractionAtOrAbove(paraphrase, threshold),
    nearMissFpr: fractionAtOrAbove(nearMiss, threshold),
  }));
}

/**
 * Fraction of (paraphrase pair, near-miss pair) combinations where the
 * near-miss pair scores strictly higher — how often the featurizer ranks a
 * wrong-answer candidate above a right one, threshold-free. 0 would mean
 * some threshold separates the classes perfectly; 0.5 is a coin flip.
 */
export function inversionRate(byClass: Map<PairClass, number[]>): number {
  const paraphrase = byClass.get("paraphrase") ?? [];
  const nearMiss = byClass.get("near-miss") ?? [];
  if (paraphrase.length === 0 || nearMiss.length === 0) return 0;
  let inversions = 0;
  for (const goodPair of paraphrase) {
    for (const badPair of nearMiss) {
      if (badPair > goodPair) inversions++;
    }
  }
  return inversions / (paraphrase.length * nearMiss.length);
}
