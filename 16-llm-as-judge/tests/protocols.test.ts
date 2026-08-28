import { describe, expect, test } from "vitest";
import { costUsd, estimateTokens } from "../../08-agent-tool-loop/src/messages.js";
import type { Answer, Pair } from "../src/dataset.js";
import { makeJudge } from "../src/judge.js";
import {
  PAIR_RUBRIC,
  pairCallTokens,
  randomizedFirstSlot,
  runPairs,
  VERDICT_TOKENS,
} from "../src/protocols.js";

function answer(id: string, quality: number, text = "some answer text"): Answer {
  return { id, text, tokens: estimateTokens(text), quality, provenance: "rival" };
}

function smallGapPair(id: string): Pair {
  return {
    id,
    question: "q",
    a: answer(`${id}-a`, 0.5),
    b: answer(`${id}-b`, 0.6),
    gold: "b",
  };
}

const noiseless = makeJudge("noiseless", { noiseSigma: 0 });
const primacy = makeJudge("pos", { noiseSigma: 0, positionBonus: 0.15 });

describe("as-stored", () => {
  test("always presents slot a first: a position-biased judge picks a on a small gap", () => {
    const run = runPairs(primacy, [smallGapPair("p1")], "as-stored", 7);
    expect(run.verdicts[0]!.verdict).toBe("a");
    expect(run.verdicts[0]!.flipped).toBe(false);
  });

  test("one call per pair with the exact prompt tokens", () => {
    const pairs = [smallGapPair("p1"), smallGapPair("p2")];
    const run = runPairs(noiseless, pairs, "as-stored", 7);
    const expectedIn = pairs.reduce((sum, p) => sum + pairCallTokens(p), 0);
    expect(run.cost.calls).toBe(2);
    expect(run.cost.tokensIn).toBe(expectedIn);
    expect(run.cost.tokensOut).toBe(2 * VERDICT_TOKENS);
    expect(run.cost.costUsd).toBeCloseTo(costUsd(expectedIn, 2 * VERDICT_TOKENS), 12);
  });
});

describe("both-order", () => {
  test("a position-biased judge flips on a small gap and the protocol abstains", () => {
    const run = runPairs(primacy, [smallGapPair("p1")], "both-order", 7);
    expect(run.verdicts[0]!.verdict).toBe("abstain");
    expect(run.verdicts[0]!.flipped).toBe(true);
  });

  test("a consistent judge keeps its verdict and doubles the cost", () => {
    const pairs = [smallGapPair("p1")];
    const run = runPairs(noiseless, pairs, "both-order", 7);
    expect(run.verdicts[0]!.verdict).toBe("b");
    expect(run.verdicts[0]!.flipped).toBe(false);
    expect(run.cost.calls).toBe(2);
    expect(run.cost.tokensIn).toBe(2 * pairCallTokens(pairs[0]!));
  });
});

describe("randomized", () => {
  test("order is a seeded property of the pair, not the judge", () => {
    expect(randomizedFirstSlot("pair-x", 7)).toBe(randomizedFirstSlot("pair-x", 7));
  });

  test("a different seed can flip the order and both slots occur across pairs", () => {
    const slots = new Set<string>();
    for (let i = 0; i < 100; i++) slots.add(randomizedFirstSlot(`pair-${i}`, 7));
    expect(slots).toEqual(new Set(["a", "b"]));
  });

  test("verdicts follow the drawn order for a position-biased judge", () => {
    const pairs = Array.from({ length: 40 }, (_, i) => smallGapPair(`p${i}`));
    const run = runPairs(primacy, pairs, "randomized", 7);
    for (let i = 0; i < pairs.length; i++) {
      expect(run.verdicts[i]!.verdict).toBe(randomizedFirstSlot(pairs[i]!.id, 7));
    }
  });
});

describe("prompt accounting", () => {
  test("pairCallTokens covers rubric, question and both answers", () => {
    const p = smallGapPair("p1");
    const expected = estimateTokens(
      `${PAIR_RUBRIC}\n${p.question}\n${p.a.text}\n${p.b.text}`,
    );
    expect(pairCallTokens(p)).toBe(expected);
  });

  test("empty pair list yields an empty run and zero cost", () => {
    const run = runPairs(noiseless, [], "both-order", 7);
    expect(run.verdicts).toEqual([]);
    expect(run.cost).toEqual({ calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 });
  });
});
