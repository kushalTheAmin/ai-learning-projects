import { describe, expect, test } from "vitest";
import {
  DEFAULT_LUHN,
  luhnScorer,
  luhnScoreSentence,
  rarityScorer,
  significantWords,
  summarize,
} from "../src/salience.js";

describe("significantWords", () => {
  test("a word must clear the frequency bar", () => {
    const sents = ["deploy went fine.", "deploy is queued.", "lunch was nice."];
    const sig = significantWords(sents, { minFrequency: 2, maxGap: 4 });
    expect(sig.has("deploy")).toBe(true);
    expect(sig.has("lunch")).toBe(false);
  });

  test("stopwords never count, however frequent", () => {
    const sents = ["the the the deploy.", "the deploy again."];
    const sig = significantWords(sents, { minFrequency: 2, maxGap: 4 });
    expect(sig.has("the")).toBe(false);
    expect(sig.has("deploy")).toBe(true);
  });
});

describe("luhnScoreSentence", () => {
  const sig = new Set(["alpha", "beta"]);

  test("two adjacent significant words score count^2 / span = 2", () => {
    expect(luhnScoreSentence("alpha beta filler words", sig, DEFAULT_LUHN)).toBe(2);
  });

  test("cluster dilution: same words separated by insignificant ones score lower", () => {
    // positions: alpha=0, beta=3 -> span 4, count 2 -> 4/4 = 1
    expect(luhnScoreSentence("alpha x y beta", sig, DEFAULT_LUHN)).toBe(1);
  });

  test("a gap beyond maxGap splits the cluster", () => {
    // five insignificant words between: gap 5 > maxGap 4, so two runs of one
    expect(luhnScoreSentence("alpha a b c d e beta", sig, DEFAULT_LUHN)).toBe(1);
    // four between: gap 4 <= maxGap, one run: 4 / 6
    expect(luhnScoreSentence("alpha a b c d beta", sig, DEFAULT_LUHN)).toBeCloseTo(4 / 6, 12);
  });

  test("no significant words scores zero", () => {
    expect(luhnScoreSentence("nothing to see here", sig, DEFAULT_LUHN)).toBe(0);
  });
});

describe("rarityScorer", () => {
  test("once-seen content words score ln(N), everywhere-words score 0", () => {
    const sents = ["deploy deploy unique-nonce.", "deploy extra today.", "deploy extra tomorrow."];
    const scored = rarityScorer()(sents);
    // sentence 0 unique content words: deploy (sf 3, ln 1 = 0), unique-nonce (sf 1, ln 3)
    expect(scored[0]?.score).toBeCloseTo(Math.log(3) / 2, 12);
    // "extra" sf 2, "today" sf 1, "deploy" sf 3 -> (ln 1.5 + ln 3 + 0) / 3
    expect(scored[1]?.score).toBeCloseTo((Math.log(3 / 2) + Math.log(3)) / 3, 12);
  });

  test("a sentence with no content words scores zero", () => {
    const scored = rarityScorer()(["the and of.", "deploy nonce."]);
    expect(scored[0]?.score).toBe(0);
  });

  test("repeats inside one sentence count once for sentence frequency", () => {
    const scored = rarityScorer()(["nonce nonce nonce.", "other words."]);
    expect(scored[0]?.score).toBeCloseTo(Math.log(2), 12);
  });
});

describe("summarize", () => {
  const scorer = rarityScorer();

  test("emits picked sentences in original order", () => {
    const sents = ["zeta quark late.", "the and of it.", "axion boson early."];
    const out = summarize(sents, 1000, scorer);
    expect(out).toEqual(["zeta quark late.", "axion boson early."]);
  });

  test("zero-scoring sentences are never picked even with room", () => {
    const out = summarize(["the and of it."], 1000, scorer);
    expect(out).toEqual([]);
  });

  test("budget packing skips an oversized sentence and continues", () => {
    // ranked by score desc; the long top sentence exceeds the budget, the
    // shorter ones still get in
    const long = "hapax-one " + "word ".repeat(50) + "hapax-two hapax-three hapax-four.";
    const short = "quark boson.";
    const out = summarize([long, short, "deploy deploy deploy.", "deploy again now."], 8, scorer);
    expect(out).toContain(short);
    expect(out).not.toContain(long);
  });

  test("budget zero yields an empty summary", () => {
    expect(summarize(["unique nonce."], 0, scorer)).toEqual([]);
  });

  test("empty input yields an empty summary", () => {
    expect(summarize([], 100, scorer)).toEqual([]);
  });

  test("equal scores tie-break to the earlier sentence", () => {
    const sents = ["aardvark one.", "zebra two."];
    // both sentences: two content words, each sf 1... except "one"/"two" are stopwords,
    // so each sentence has one hapax content word and identical score ln(2)
    const scored = rarityScorer()(sents);
    expect(scored[0]?.score).toBeCloseTo(scored[1]?.score ?? NaN, 12);
    const out = summarize(sents, 4, scorer);
    expect(out).toEqual(["aardvark one."]);
  });

  test("luhn and rarity rank a transcript in opposite directions", () => {
    // chatter repeats its vocabulary; the decision appears once
    const sents = [
      "deploy checks look stable and the deploy graphs look stable.",
      "deploy checks look stable again and the graphs look stable again.",
      "decision: rollout target is vega-atlas-7.",
    ];
    const luhn = luhnScorer()(sents);
    const rarity = rarityScorer()(sents);
    const topLuhn = [...luhn].sort((a, b) => b.score - a.score)[0];
    const topRarity = [...rarity].sort((a, b) => b.score - a.score)[0];
    expect(topLuhn?.index).not.toBe(2);
    expect(topRarity?.index).toBe(2);
  });

  test("deterministic across calls", () => {
    const sents = ["quark boson lepton.", "deploy deploy again.", "meson gluon photon."];
    expect(summarize(sents, 12, scorer)).toEqual(summarize(sents, 12, scorer));
  });
});
