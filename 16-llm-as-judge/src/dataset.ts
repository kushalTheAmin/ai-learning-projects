/**
 * Seeded benchmark generator. Every answer carries a latent quality score in
 * [0, 1]; gold labels come from that latent, and the scripted judges score the
 * latent plus their authored biases, never the text. The text exists so token
 * and cost accounting run over real strings, and each targeted set balances
 * one attribute exactly (by construction, not by sampling) so a bias shows up
 * as a deviation from a known 50% or a known pass rate.
 */

import { estimateTokens } from "../../08-agent-tool-loop/src/messages.js";
import { streamFor, uniform } from "./rand.js";
import type { Rng } from "../../05-token-streaming/src/rng.js";

export type Provenance = "house" | "rival";

export interface Answer {
  id: string;
  text: string;
  /** estimateTokens(text), precomputed once. */
  tokens: number;
  /** Latent quality in [0, 1]; the gold labels and the scripted judges read this. */
  quality: number;
  provenance: Provenance;
}

export interface GradingItem {
  id: string;
  question: string;
  answer: Answer;
  goldPass: boolean;
}

export type Slot = "a" | "b";

export interface Pair {
  id: string;
  question: string;
  a: Answer;
  b: Answer;
  /** Which canonical slot holds the higher-quality answer. */
  gold: Slot;
}

export interface Dataset {
  /** Pointwise pass/fail set; gold pass rate is exactly PASS_RATE. */
  grading: GradingItem[];
  /** Balanced pairs: stored order, lengths and provenance carry no signal. */
  corePairs: Pair[];
  /** Slot a is always the incumbent; the challenger in b is better in exactly half. */
  championPairs: Pair[];
  /** One house and one rival answer per pair; house is better in exactly half. */
  housePairs: Pair[];
  /** One short and one long answer per pair; the long one is better in exactly half. */
  lengthPairs: Pair[];
}

export const GRADING_COUNT = 200;
export const CORE_COUNT = 150;
export const CHAMPION_COUNT = 100;
export const HOUSE_COUNT = 100;
export const LENGTH_COUNT = 100;

/** 7 of every 10 grading answers pass, so always-pass scores 0.70 for free. */
export const PASS_RATE = 0.7;
export const PASS_QUALITY: readonly [number, number] = [0.65, 0.95];
export const FAIL_QUALITY: readonly [number, number] = [0.2, 0.55];
export const PASS_CUTOFF = 0.6;

/** Pairwise quality gaps; the floor keeps noise from dominating every verdict. */
export const GAP_RANGE: readonly [number, number] = [0.08, 0.4];

const QUESTION_STEMS = [
  "how should the service handle a burst of duplicate webhook deliveries",
  "what is the right retention policy for raw request logs",
  "how do we roll back a bad schema migration without downtime",
  "when should a background job be retried versus dead-lettered",
  "how should api pagination behave when rows are inserted mid-scan",
  "what belongs in the healthcheck for the ingest worker",
  "how do we cap memory in the streaming export path",
  "what is the safest way to rotate the signing keys",
  "how should the cache behave when the upstream returns stale data",
  "what should the on-call runbook say about queue depth alarms",
];

const SENTENCE_BANK = [
  "Start by writing the invariant down so every reviewer checks the same thing.",
  "The worker should treat the queue as the source of truth and keep no local state.",
  "Idempotency keys make the retry safe because the second delivery becomes a no-op.",
  "Budget the memory per batch, not per process, so concurrency stays bounded.",
  "A feature flag lets the migration ship dark and roll back in one click.",
  "Alert on the rate of change rather than the absolute number to catch regressions early.",
  "Keep the hot path allocation free and push formatting to the edge.",
  "Every timeout needs an owner, a default, and a test that exercises it.",
  "Réponse times degrade gradually, so percentiles tell the story averages hide.",
  "The naïve approach re-reads the whole table and falls over past a few million rows.",
  "Backpressure should propagate to the producer instead of buffering without bound.",
  "Serialize the payload once and reuse the bytes for both the log and the wire.",
  "Health checks must exercise the dependency the traffic actually uses.",
  "Prefer monotonic clocks for intervals so a wall clock step cannot fire the alarm.",
  "Ship the measurement first, then the fix, so the improvement has a baseline.",
  "Cache entries need a version in the key or the deploy serves mixed responses.",
  "Every retry multiplies load on a struggling dependency, so cap the total budget.",
  "Document the failure mode next to the code that causes it, not in a wiki.",
];

/** Append bank sentences until the text reaches the target token estimate. */
export function buildText(rng: Rng, targetTokens: number): string {
  const parts: string[] = [];
  let text = "";
  while (estimateTokens(text) < targetTokens) {
    const sentence = SENTENCE_BANK[Math.floor(rng() * SENTENCE_BANK.length)]!;
    parts.push(sentence);
    text = parts.join(" ");
  }
  return text;
}

export function makeAnswer(
  id: string,
  rng: Rng,
  quality: number,
  targetTokens: number,
  provenance: Provenance,
): Answer {
  const text = buildText(rng, targetTokens);
  return { id, text, tokens: estimateTokens(text), quality, provenance };
}

function question(rng: Rng): string {
  return QUESTION_STEMS[Math.floor(rng() * QUESTION_STEMS.length)]!;
}

function pad(n: number): string {
  return String(n).padStart(3, "0");
}

function buildGrading(seed: number): GradingItem[] {
  const rng = streamFor(`dataset|grading|${seed}`);
  const items: GradingItem[] = [];
  for (let i = 0; i < GRADING_COUNT; i++) {
    const goldPass = i % 10 < PASS_RATE * 10;
    const [lo, hi] = goldPass ? PASS_QUALITY : FAIL_QUALITY;
    const id = `grade-${pad(i)}`;
    const answer = makeAnswer(
      `${id}-ans`,
      rng,
      uniform(rng, lo, hi),
      Math.round(uniform(rng, 60, 260)),
      i % 2 === 0 ? "house" : "rival",
    );
    items.push({ id, question: question(rng), answer, goldPass });
  }
  return items;
}

interface PairPlan {
  /** Does the higher-quality answer land in slot a? */
  betterInA: boolean;
  tokensA: number;
  tokensB: number;
  provenanceA: Provenance;
  provenanceB: Provenance;
}

function buildPair(id: string, rng: Rng, plan: PairPlan): Pair {
  const low = uniform(rng, 0.15, 0.55);
  const high = low + uniform(rng, GAP_RANGE[0], GAP_RANGE[1]);
  const a = makeAnswer(
    `${id}-a`,
    rng,
    plan.betterInA ? high : low,
    plan.tokensA,
    plan.provenanceA,
  );
  const b = makeAnswer(
    `${id}-b`,
    rng,
    plan.betterInA ? low : high,
    plan.tokensB,
    plan.provenanceB,
  );
  return { id, question: question(rng), a, b, gold: plan.betterInA ? "a" : "b" };
}

function midLength(rng: Rng): number {
  return Math.round(uniform(rng, 50, 250));
}

function buildCorePairs(seed: number): Pair[] {
  const rng = streamFor(`dataset|core|${seed}`);
  const pairs: Pair[] = [];
  for (let i = 0; i < CORE_COUNT; i++) {
    pairs.push(
      buildPair(`core-${pad(i)}`, rng, {
        betterInA: i % 2 === 0,
        tokensA: midLength(rng),
        tokensB: midLength(rng),
        provenanceA: "rival",
        provenanceB: "rival",
      }),
    );
  }
  return pairs;
}

function buildChampionPairs(seed: number): Pair[] {
  const rng = streamFor(`dataset|champion|${seed}`);
  const pairs: Pair[] = [];
  for (let i = 0; i < CHAMPION_COUNT; i++) {
    pairs.push(
      buildPair(`champ-${pad(i)}`, rng, {
        betterInA: i % 2 === 0,
        tokensA: midLength(rng),
        tokensB: midLength(rng),
        provenanceA: "rival",
        provenanceB: "rival",
      }),
    );
  }
  return pairs;
}

function buildHousePairs(seed: number): Pair[] {
  const rng = streamFor(`dataset|house|${seed}`);
  const pairs: Pair[] = [];
  for (let i = 0; i < HOUSE_COUNT; i++) {
    // House sits in slot a for even i, and is the better answer when i % 4 < 2,
    // so house-better and house-in-a are each exactly half and uncorrelated.
    const houseInA = i % 2 === 0;
    const houseBetter = i % 4 < 2;
    pairs.push(
      buildPair(`house-${pad(i)}`, rng, {
        betterInA: houseInA === houseBetter,
        tokensA: midLength(rng),
        tokensB: midLength(rng),
        provenanceA: houseInA ? "house" : "rival",
        provenanceB: houseInA ? "rival" : "house",
      }),
    );
  }
  return pairs;
}

function shortLength(rng: Rng): number {
  return Math.round(uniform(rng, 40, 70));
}

function longLength(rng: Rng): number {
  return Math.round(uniform(rng, 200, 300));
}

function buildLengthPairs(seed: number): Pair[] {
  const rng = streamFor(`dataset|length|${seed}`);
  const pairs: Pair[] = [];
  for (let i = 0; i < LENGTH_COUNT; i++) {
    // Same interleave as housePairs: long-in-a and long-better are each exactly
    // half and uncorrelated with each other.
    const longInA = i % 2 === 0;
    const longBetter = i % 4 < 2;
    pairs.push(
      buildPair(`len-${pad(i)}`, rng, {
        betterInA: longInA === longBetter,
        tokensA: longInA ? longLength(rng) : shortLength(rng),
        tokensB: longInA ? shortLength(rng) : longLength(rng),
        provenanceA: "rival",
        provenanceB: "rival",
      }),
    );
  }
  return pairs;
}

function assertBalance(dataset: Dataset): void {
  const passCount = dataset.grading.filter((g) => g.goldPass).length;
  if (passCount !== GRADING_COUNT * PASS_RATE) {
    throw new Error(`grading pass count ${passCount} is off target`);
  }
  for (const g of dataset.grading) {
    if (g.goldPass !== g.answer.quality >= PASS_CUTOFF) {
      throw new Error(`grading label disagrees with quality on ${g.id}`);
    }
  }
  const half = (pairs: Pair[], name: string, count: (p: Pair) => boolean): void => {
    const hits = pairs.filter(count).length;
    if (hits * 2 !== pairs.length) {
      throw new Error(`${name} balance is ${hits}/${pairs.length}, expected half`);
    }
  };
  half(dataset.corePairs, "core stored-order", (p) => p.gold === "a");
  half(dataset.championPairs, "challenger-better", (p) => p.gold === "b");
  half(dataset.housePairs, "house-better", (p) => better(p).provenance === "house");
  half(dataset.housePairs, "house-in-a", (p) => p.a.provenance === "house");
  half(dataset.lengthPairs, "long-better", (p) => better(p).tokens > worse(p).tokens);
  half(dataset.lengthPairs, "long-in-a", (p) => p.a.tokens > p.b.tokens);
  for (const p of allPairs(dataset)) {
    const gap = better(p).quality - worse(p).quality;
    if (gap < GAP_RANGE[0]) throw new Error(`gap ${gap} below floor on ${p.id}`);
  }
}

export function better(pair: Pair): Answer {
  return pair.gold === "a" ? pair.a : pair.b;
}

export function worse(pair: Pair): Answer {
  return pair.gold === "a" ? pair.b : pair.a;
}

export function allPairs(dataset: Dataset): Pair[] {
  return [
    ...dataset.corePairs,
    ...dataset.championPairs,
    ...dataset.housePairs,
    ...dataset.lengthPairs,
  ];
}

export function buildDataset(seed: number): Dataset {
  const dataset: Dataset = {
    grading: buildGrading(seed),
    corePairs: buildCorePairs(seed),
    championPairs: buildChampionPairs(seed),
    housePairs: buildHousePairs(seed),
    lengthPairs: buildLengthPairs(seed),
  };
  assertBalance(dataset);
  return dataset;
}
