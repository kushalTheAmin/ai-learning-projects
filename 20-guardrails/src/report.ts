/**
 * Pure aggregation helpers the entry point prints. Kept out of main.ts so
 * the tests can pin the numbers without capturing stdout.
 */

import type { PromptItem } from "./dataset.js";
import { DEFAULT_ENTROPY_THRESHOLD, detectPii, type DetectOptions } from "./pii.js";
import { entropyBitsPerChar } from "./checks.js";
import { scoreInjection, type ScoreOptions } from "./injection.js";
import {
  addCounts,
  finalize,
  perTypeCounts,
  rocAuc,
  scorePiiSpans,
  sweepThresholds,
  type PrCounts,
  type PrFScore,
  type RocPoint,
} from "./metrics.js";
import type { PiiItem } from "./dataset.js";
import type { PiiType } from "./pii.js";

export interface PiiEval {
  overall: PrFScore;
  perType: Map<PiiType, PrFScore>;
}

export function evalPii(corpus: PiiItem[], opts: DetectOptions = {}): PiiEval {
  let overall: PrCounts = { tp: 0, fp: 0, fn: 0 };
  const perType = new Map<PiiType, PrCounts>();
  for (const item of corpus) {
    const pred = detectPii(item.text, opts);
    overall = addCounts(overall, scorePiiSpans(item.spans, pred));
    for (const [type, counts] of perTypeCounts(item.spans, pred)) {
      perType.set(type, addCounts(perType.get(type) ?? { tp: 0, fp: 0, fn: 0 }, counts));
    }
  }
  const perTypeScored = new Map<PiiType, PrFScore>();
  for (const [type, counts] of perType) perTypeScored.set(type, finalize(counts));
  return { overall: finalize(overall), perType: perTypeScored };
}

export interface MissedAttack {
  id: string;
  category: string;
  score: number;
  /** rules that fired anyway; empty means nothing matched at all */
  ruleIds: string[];
}

export interface InjectionEval {
  auc: number;
  sweep: RocPoint[];
  attackScores: number[];
  benignScores: number[];
  /** per-category detection at a given threshold: fraction of attacks flagged */
  categoryDetection: Map<string, { flagged: number; total: number }>;
  /**
   * attacks the gate lets through, in corpus order. a miss with a non-empty
   * ruleIds is a near miss: the rules covered it and the weights did not add
   * up, which is a different failure from a prompt no rule sees.
   */
  missedAtThreshold: MissedAttack[];
}

export function evalInjection(
  prompts: PromptItem[],
  scoring: ScoreOptions,
  threshold: number,
): InjectionEval {
  const attacks = prompts.filter((p) => p.kind === "attack");
  const benign = prompts.filter((p) => p.kind === "benign");
  const attackHits = attacks.map((p) => scoreInjection(p.text, scoring));
  const attackScores = attackHits.map((r) => r.score);
  const benignScores = benign.map((p) => scoreInjection(p.text, scoring).score);
  const categoryDetection = new Map<string, { flagged: number; total: number }>();
  const missedAtThreshold: MissedAttack[] = [];
  attacks.forEach((p, i) => {
    const entry = categoryDetection.get(p.category) ?? { flagged: 0, total: 0 };
    entry.total += 1;
    if ((attackScores[i] ?? 0) >= threshold) entry.flagged += 1;
    else {
      missedAtThreshold.push({
        id: p.id,
        category: p.category,
        score: attackScores[i] ?? 0,
        ruleIds: (attackHits[i]?.hits ?? []).map((h) => h.ruleId),
      });
    }
    categoryDetection.set(p.category, entry);
  });
  return {
    auc: rocAuc(attackScores, benignScores),
    sweep: sweepThresholds(attackScores, benignScores),
    attackScores,
    benignScores,
    categoryDetection,
    missedAtThreshold,
  };
}

/**
 * The entropy gate's recall side. The ablation above prices what the gate
 * buys — one hard negative kept out — and the corpus cannot price what it
 * costs, because its one prefix-less gold secret is 32 distinct characters.
 *
 * Empirical entropy is bounded above by log2(distinct characters), so the
 * bound, not the randomness, is what decides a short or small-alphabet
 * token. A hex credential tops out at the gate's own threshold and a real
 * one lands under it; a token at the candidate regex's 20 character floor
 * drops under it as soon as four characters repeat.
 */
export const GATE_TOKENS: readonly { label: string; token: string }[] = [
  { label: "40 char git sha", token: "9f2a7c1e4b8d0a3f6e5c2b9d8a7f6e5c4b3a2d1f" },
  { label: "32 char md5 digest", token: "d41d8cd98f00b204e9800998ecf8427e" },
];

/** 20 distinct characters: the candidate regex's shortest accepted token */
export const FLOOR_BASE = "r7KdQ2mXv9Lp3Wn8Zt4A";

/** same length, `repeats` of the distinct characters swapped for duplicates */
function floorToken(repeats: number): string {
  return FLOOR_BASE.slice(0, FLOOR_BASE.length - repeats) + FLOOR_BASE.slice(0, repeats);
}

export interface GateRow {
  label: string;
  token: string;
  bits: number;
  clearsGate: boolean;
}

export interface FloorRow extends GateRow {
  repeats: number;
}

export interface GoldSecretRow {
  value: string;
  length: number;
  distinct: number;
  bits: number;
}

export interface EntropyGateProbe {
  threshold: number;
  /** a perfectly balanced hex string, the best any hex token can do */
  hexCeiling: number;
  tokens: GateRow[];
  atFloor: FloorRow[];
  /** gold SECRET spans no prefix rule can find, so only the gate finds them */
  goldPrefixless: GoldSecretRow[];
}

export function entropyGateProbe(
  corpus: PiiItem[],
  threshold: number = DEFAULT_ENTROPY_THRESHOLD,
): EntropyGateProbe {
  const row = (label: string, token: string): GateRow => ({
    label,
    token,
    bits: entropyBitsPerChar(token),
    clearsGate: entropyBitsPerChar(token) >= threshold,
  });
  const goldPrefixless: GoldSecretRow[] = [];
  for (const item of corpus) {
    for (const span of item.spans) {
      if (span.type !== "SECRET") continue;
      // an unreachable gate leaves only the prefix detector; nothing found
      // there means this secret exists in the corpus only because of the gate
      const byPrefix = detectPii(span.value, { entropyThreshold: Number.POSITIVE_INFINITY });
      if (byPrefix.some((s) => s.type === "SECRET")) continue;
      goldPrefixless.push({
        value: span.value,
        length: span.value.length,
        distinct: new Set(span.value).size,
        bits: entropyBitsPerChar(span.value),
      });
    }
  }
  return {
    threshold,
    hexCeiling: entropyBitsPerChar("0123456789abcdef".repeat(2)),
    tokens: GATE_TOKENS.map((t) => row(t.label, t.token)),
    atFloor: [0, 1, 2, 3, 4].map((repeats) => ({
      repeats,
      ...row(`${repeats} repeated`, floorToken(repeats)),
    })),
    goldPrefixless,
  };
}
