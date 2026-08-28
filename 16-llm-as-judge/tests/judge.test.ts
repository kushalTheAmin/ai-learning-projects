import { describe, expect, test } from "vitest";
import type { Answer, Pair } from "../src/dataset.js";
import {
  gradePointwise,
  JUDGES,
  judgeByName,
  judgePair,
  LENGTH_PIVOT,
  makeJudge,
} from "../src/judge.js";

function answer(overrides: Partial<Answer> & { id: string }): Answer {
  return {
    text: "stub text",
    tokens: LENGTH_PIVOT,
    quality: 0.5,
    provenance: "rival",
    ...overrides,
  };
}

function pair(a: Answer, b: Answer): Pair {
  const gold = a.quality >= b.quality ? "a" : "b";
  return { id: "pair-1", question: "q", a, b, gold };
}

describe("quality scoring", () => {
  const noiseless = makeJudge("noiseless", { noiseSigma: 0 });

  test("the higher-quality answer wins in either presentation order", () => {
    const p = pair(answer({ id: "x", quality: 0.7 }), answer({ id: "y", quality: 0.5 }));
    expect(judgePair(noiseless, p, "a")).toBe("a");
    expect(judgePair(noiseless, p, "b")).toBe("a");
  });

  test("an exact score tie goes to the first-presented answer", () => {
    const p = pair(answer({ id: "x", quality: 0.5 }), answer({ id: "y", quality: 0.5 }));
    expect(judgePair(noiseless, p, "a")).toBe("a");
    expect(judgePair(noiseless, p, "b")).toBe("b");
  });
});

describe("position bonus", () => {
  const biased = makeJudge("pos", { noiseSigma: 0, positionBonus: 0.15 });

  test("overrides a small gap: the first-presented answer wins both orders", () => {
    const p = pair(answer({ id: "x", quality: 0.6 }), answer({ id: "y", quality: 0.5 }));
    expect(judgePair(biased, p, "a")).toBe("a");
    expect(judgePair(biased, p, "b")).toBe("b");
  });

  test("loses to a large gap: the better answer wins both orders", () => {
    const p = pair(answer({ id: "x", quality: 0.8 }), answer({ id: "y", quality: 0.5 }));
    expect(judgePair(biased, p, "a")).toBe("a");
    expect(judgePair(biased, p, "b")).toBe("a");
  });
});

describe("self bonus", () => {
  const partial = makeJudge("self", { noiseSigma: 0, selfBonus: 0.15 });

  test("flips a small deficit for the house answer, in either order", () => {
    const p = pair(
      answer({ id: "x", quality: 0.5, provenance: "house" }),
      answer({ id: "y", quality: 0.6 }),
    );
    expect(judgePair(partial, p, "a")).toBe("a");
    expect(judgePair(partial, p, "b")).toBe("a");
  });

  test("cannot flip a large deficit", () => {
    const p = pair(
      answer({ id: "x", quality: 0.4, provenance: "house" }),
      answer({ id: "y", quality: 0.7 }),
    );
    expect(judgePair(partial, p, "a")).toBe("b");
  });
});

describe("length weight", () => {
  const wordy = makeJudge("wordy", { noiseSigma: 0, lengthWeight: 0.2 });

  test("a much longer answer beats a better short one when the term exceeds the gap", () => {
    // 0.2 * ln(300/50) = 0.358 > gap 0.3
    const p = pair(
      answer({ id: "x", quality: 0.8, tokens: 50 }),
      answer({ id: "y", quality: 0.5, tokens: 300 }),
    );
    expect(judgePair(wordy, p, "a")).toBe("b");
    expect(judgePair(wordy, p, "b")).toBe("b");
  });

  test("length is symmetric around the pivot and cannot beat a dominant gap", () => {
    const p = pair(
      answer({ id: "x", quality: 0.9, tokens: 50 }),
      answer({ id: "y", quality: 0.2, tokens: 300 }),
    );
    expect(judgePair(wordy, p, "a")).toBe("a");
  });
});

describe("pointwise grading", () => {
  test("threshold binds exactly at the cutoff", () => {
    const strict = makeJudge("strict", { noiseSigma: 0, passThreshold: 0.6 });
    expect(gradePointwise(strict, "g1", answer({ id: "x", quality: 0.61 }))).toBe(true);
    expect(gradePointwise(strict, "g2", answer({ id: "y", quality: 0.59 }))).toBe(false);
  });

  test("a lower threshold passes what a calibrated one fails", () => {
    const lax = makeJudge("lax", { noiseSigma: 0, passThreshold: 0.25 });
    expect(gradePointwise(lax, "g3", answer({ id: "z", quality: 0.4 }))).toBe(true);
  });
});

describe("determinism and noise", () => {
  test("a noisy call replays identically", () => {
    const noisy = makeJudge("noisy", { noiseSigma: 0.5 });
    const p = pair(answer({ id: "x", quality: 0.55 }), answer({ id: "y", quality: 0.45 }));
    expect(judgePair(noisy, p, "a")).toBe(judgePair(noisy, p, "a"));
    expect(gradePointwise(noisy, "g", p.a)).toBe(gradePointwise(noisy, "g", p.a));
  });

  test("the coin judge is order-agnostic chance: first wins about half of calls", () => {
    const coin = judgeByName("coin");
    let firstWins = 0;
    const n = 500;
    for (let i = 0; i < n; i++) {
      const p: Pair = {
        id: `coin-${i}`,
        question: "q",
        a: answer({ id: `a${i}`, quality: 0.9 }),
        b: answer({ id: `b${i}`, quality: 0.2 }),
        gold: "a",
      };
      if (judgePair(coin, p, "a") === "a") firstWins++;
    }
    expect(firstWins / n).toBeGreaterThan(0.42);
    expect(firstWins / n).toBeLessThan(0.58);
  });
});

describe("the cast", () => {
  test("names are unique and judgeByName round-trips", () => {
    const names = JUDGES.map((j) => j.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(judgeByName(name).name).toBe(name);
    expect(() => judgeByName("nobody")).toThrow();
  });
});
