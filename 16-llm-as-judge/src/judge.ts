/**
 * Scripted judge family. A judge scores an answer's latent quality plus its
 * authored biases and noise; it never reads the text. Every bias here has a
 * documented real-world counterpart, and its size is a known constant, so the
 * harness downstream is being tested on whether it can detect and correct a
 * bias whose true magnitude is on record.
 */

import type { Answer, Pair, Slot } from "./dataset.js";
import { gaussian, streamFor } from "./rand.js";

export interface JudgeSpec {
  name: string;
  /** Weight on the latent quality; 0 makes verdicts pure noise. */
  qualityWeight: number;
  /** Std dev of per-answer gaussian noise added to each look at an answer. */
  noiseSigma: number;
  /** Added to whichever answer is presented first in a pairwise call. */
  positionBonus: number;
  /** Multiplies ln(tokens / LENGTH_PIVOT): rewards long answers, penalizes short. */
  lengthWeight: number;
  /** Added when the answer's provenance is "house". */
  selfBonus: number;
  /** Pointwise pass cutoff on the latent score. */
  passThreshold: number;
}

/** Token count at which the length term is exactly zero. */
export const LENGTH_PIVOT = 120;

const BASE: Omit<JudgeSpec, "name"> = {
  qualityWeight: 1,
  noiseSigma: 0.04,
  positionBonus: 0,
  lengthWeight: 0,
  selfBonus: 0,
  passThreshold: 0.6,
};

export function makeJudge(name: string, overrides: Partial<Omit<JudgeSpec, "name">> = {}): JudgeSpec {
  return { name, ...BASE, ...overrides };
}

/**
 * The cast. calibrated is the ceiling, coin the floor; each other judge
 * carries exactly one authored failure so its signature is unambiguous.
 */
export const JUDGES: readonly JudgeSpec[] = [
  makeJudge("calibrated"),
  makeJudge("lenient", { passThreshold: 0.25 }),
  makeJudge("primacy", { positionBonus: 0.15 }),
  makeJudge("verbose", { lengthWeight: 0.2 }),
  makeJudge("self-pref", { selfBonus: 0.15 }),
  makeJudge("coin", { qualityWeight: 0, noiseSigma: 1, passThreshold: 0 }),
];

export function judgeByName(name: string): JudgeSpec {
  const judge = JUDGES.find((j) => j.name === name);
  if (!judge) throw new Error(`no judge named ${name}`);
  return judge;
}

function latentScore(judge: JudgeSpec, answer: Answer, noise: number): number {
  return (
    judge.qualityWeight * answer.quality +
    judge.lengthWeight * Math.log(answer.tokens / LENGTH_PIVOT) +
    (answer.provenance === "house" ? judge.selfBonus : 0) +
    judge.noiseSigma * noise
  );
}

/** One pointwise pass/fail call. Deterministic per (judge, item id). */
export function gradePointwise(judge: JudgeSpec, itemId: string, answer: Answer): boolean {
  const rng = streamFor(`${judge.name}|point|${itemId}`);
  return latentScore(judge, answer, gaussian(rng)) >= judge.passThreshold;
}

/**
 * One pairwise call with the given presentation order. The two orders derive
 * different rng streams, the way two separate model calls draw independent
 * noise. Returns the winning canonical slot. An exact score tie goes to the
 * first-presented answer, the way a forced-choice prompt breaks ties.
 */
export function judgePair(judge: JudgeSpec, pair: Pair, firstSlot: Slot): Slot {
  const first = firstSlot === "a" ? pair.a : pair.b;
  const second = firstSlot === "a" ? pair.b : pair.a;
  const rng = streamFor(`${judge.name}|pair|${pair.id}|${firstSlot}`);
  const firstScore = latentScore(judge, first, gaussian(rng)) + judge.positionBonus;
  const secondScore = latentScore(judge, second, gaussian(rng));
  const firstWins = firstScore >= secondScore;
  if (firstWins) return firstSlot;
  return firstSlot === "a" ? "b" : "a";
}
