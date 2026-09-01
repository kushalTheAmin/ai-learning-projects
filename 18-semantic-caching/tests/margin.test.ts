import { describe, expect, it } from "vitest";
import { SemanticCache, type MarginPolicy } from "../src/cache.js";
import { FEATURIZERS } from "../src/features.js";
import { gapStudy, marginSweep, monotonicityViolations, thresholdSweepUnderMargin } from "../src/margin.js";
import { runReplay, seedSpread, SPREAD_SEEDS, type ServeRecord } from "../src/replay.js";
import { DEFAULT_TRAFFIC, generateTraffic, type TrafficRequest } from "../src/traffic.js";

const word = FEATURIZERS[0]!;
const char = FEATURIZERS[1]!;

const TRAFFIC = generateTraffic(DEFAULT_TRAFFIC);

function request(text: string, intentId: string): TrafficRequest {
  return { text, intentId, phrasingClass: "canonical", typoed: false };
}

const differing = (margin: number): MarginPolicy => ({ margin, scope: "differing-answer" });
const all = (margin: number): MarginPolicy => ({ margin, scope: "all" });

describe("SemanticCache margin policy", () => {
  it("same-answer crowding blocks the all scope and not the differing-answer scope", () => {
    // Two phrasings of one intent share one answer text. A query close to
    // both has a tiny gap over "all" entries but no differing-answer
    // competitor at all.
    const build = (policy: MarginPolicy): SemanticCache => {
      const cache = new SemanticCache(word, 0.3, policy);
      cache.insert("raise my rate limit", "answer-limits", "intent-a");
      cache.insert("raise my rate limit now", "answer-limits", "intent-a");
      return cache;
    };
    expect(build(all(0.9)).lookup("hey raise my rate limit please").kind).toBe("margin-refused");
    expect(build(differing(0.9)).lookup("hey raise my rate limit please").kind).toBe("semantic");
  });

  it("a differing-answer competitor inside the margin refuses the serve", () => {
    const build = (policy?: MarginPolicy): SemanticCache => {
      const cache = new SemanticCache(word, 0.3, policy);
      cache.insert("raise my rate limit", "answer-limits", "intent-a");
      cache.insert("raise my storage quota", "answer-storage", "intent-b");
      return cache;
    };
    const served = build().lookup("hey raise my rate limit please");
    expect(served.kind).toBe("semantic");
    if (served.kind === "semantic") {
      expect(served.competitorAll).toBeDefined();
      expect(served.competitorDiffering).toBeDefined();
      expect(served.competitorAll!).toBeLessThanOrEqual(served.similarity);
    }
    const refused = build(differing(0.9)).lookup("hey raise my rate limit please");
    expect(refused.kind).toBe("margin-refused");
    if (refused.kind === "margin-refused") {
      expect(refused.entry.answer).toBe("answer-limits");
      expect(refused.competitor).toBeLessThanOrEqual(refused.similarity);
      expect(refused.similarity - refused.competitor).toBeLessThan(0.9);
    }
  });

  it("a serve with no in-scope competitor passes any margin", () => {
    const lone = new SemanticCache(word, 0.3, all(0.99));
    lone.insert("reset my password", "answer-a", "intent-a");
    const decision = lone.lookup("hey reset my password please");
    expect(decision.kind).toBe("semantic");
    if (decision.kind === "semantic") {
      expect(decision.competitorAll).toBeUndefined();
      expect(decision.competitorDiffering).toBeUndefined();
    }
  });

  it("margin 0 behaves exactly like no policy", () => {
    const query = "hey raise my rate limit please";
    const withPolicy = new SemanticCache(word, 0.3, all(0));
    const without = new SemanticCache(word, 0.3);
    for (const cache of [withPolicy, without]) {
      cache.insert("raise my rate limit", "answer-limits", "intent-a");
      cache.insert("raise my rate limits", "answer-limits", "intent-a");
    }
    expect(withPolicy.lookup(query)).toEqual(without.lookup(query));
  });

  it("a similarity tie is a zero gap, refused at any positive margin under the all scope", () => {
    const cache = new SemanticCache(word, 0.1, all(0.01));
    // both entries share exactly the unigram "a" with the query "a b"
    cache.insert("a c", "first", "intent-a");
    cache.insert("a d", "second", "intent-b");
    const decision = cache.lookup("a b");
    expect(decision.kind).toBe("margin-refused");
    if (decision.kind === "margin-refused") {
      expect(decision.entry.answer).toBe("first");
      expect(decision.competitor).toBe(decision.similarity);
    }
  });

  it("the exact layer bypasses the margin rule", () => {
    const cache = new SemanticCache(word, 0.3, all(0.99));
    cache.insert("delete my account data", "answer-a", "intent-a");
    cache.insert("delete my account datum", "answer-b", "intent-b");
    expect(cache.lookup("Delete my account data!").kind).toBe("exact");
  });

  it("handles empty and unicode queries under a margin policy", () => {
    const cache = new SemanticCache(word, 0.5, differing(0.2));
    cache.insert("réinitialiser mon mot de passe 🔑", "answer-fr", "intent-fr");
    expect(cache.lookup("").kind).toBe("miss");
    expect(cache.lookup("réinitialiser mon mot de passe 🔑 svp").kind).toBe("semantic");
  });
});

describe("runReplay under a margin policy", () => {
  it("with no policy the margin counters stay zero", () => {
    const result = runReplay(TRAFFIC, word, 0.75, "word");
    expect(result.marginRefusals).toBe(0);
    expect(result.refusedRight).toBe(0);
    expect(result.refusedWrong).toBe(0);
  });

  it("margin 0 reproduces the no-policy replay exactly", () => {
    const bare = runReplay(TRAFFIC, word, 0.75, "word");
    const zeroMargin = runReplay(TRAFFIC, word, 0.75, "word", differing(0));
    expect(zeroMargin).toEqual(bare);
  });

  it("counts a refused right serve and still answers the request with a model call", () => {
    const traffic = [
      request("reset my password", "reset-password"),
      request("reset my api key", "reset-api-key"),
      request("reset my api key please", "reset-api-key"),
    ];
    // At 0.6 the second request misses and inserts, so the third sees both
    // intents stored: best is its own intent, but the sibling sits within
    // the 0.5 margin.
    const refusing = runReplay(traffic, word, 0.6, "word", differing(0.5));
    expect(refusing.llmCalls).toBe(3);
    expect(refusing.marginRefusals).toBe(1);
    expect(refusing.refusedRight).toBe(1);
    expect(refusing.refusedWrong).toBe(0);
    const serving = runReplay(traffic, word, 0.6, "word", differing(0.3));
    expect(serving.llmCalls).toBe(2);
    expect(serving.semanticCorrect).toBe(1);
    expect(serving.marginRefusals).toBe(0);
  });

  it("counts a refused wrong serve", () => {
    const traffic = [
      request("reset my password", "reset-password"),
      request("reset my api key", "reset-api-key"),
      request("reset my password please", "reset-api-key"),
    ];
    const result = runReplay(traffic, word, 0.6, "word", differing(0.5));
    expect(result.marginRefusals).toBe(1);
    expect(result.refusedWrong).toBe(1);
    expect(result.refusedRight).toBe(0);
  });

  it("cannot refuse the first cross-intent collision: nothing else is stored yet", () => {
    const traffic = [request("reset my password", "reset-password"), request("reset my api key", "reset-api-key")];
    const result = runReplay(traffic, word, 0.4, "word", differing(0.99));
    expect(result.semanticWrong).toBe(1);
    expect(result.marginRefusals).toBe(0);
  });

  it("accounts every request exactly once, refusals inside the model calls", () => {
    const result = runReplay(TRAFFIC, word, 0.5, "word", differing(0.1));
    const total = result.llmCalls + result.exactHits + result.semanticCorrect + result.semanticWrong;
    expect(total).toBe(TRAFFIC.length);
    expect(result.refusedRight + result.refusedWrong).toBe(result.marginRefusals);
    expect(result.marginRefusals).toBeLessThanOrEqual(result.llmCalls);
  });

  it("is deterministic under a margin policy", () => {
    const a = runReplay(TRAFFIC, word, 0.5, "word", differing(0.1));
    const b = runReplay(TRAFFIC, word, 0.5, "word", differing(0.1));
    expect(a).toEqual(b);
  });

  it("reports every semantic serve to the observer", () => {
    const records: ServeRecord[] = [];
    const result = runReplay(TRAFFIC, word, 0.75, "word", undefined, (record) => records.push(record));
    expect(records.length).toBe(result.semanticCorrect + result.semanticWrong);
    expect(records.filter((record) => record.right).length).toBe(result.semanticCorrect);
    for (const record of records) {
      if (record.competitorAll !== undefined) {
        expect(record.competitorAll).toBeLessThanOrEqual(record.similarity + 1e-12);
      }
    }
  });
});

describe("gap study", () => {
  it("matches the margin-0 replay it observes", () => {
    const study = gapStudy(TRAFFIC, word, 0.5);
    const replay = runReplay(TRAFFIC, word, 0.5, "word");
    expect(study.right.serves).toBe(replay.semanticCorrect);
    expect(study.wrong.serves).toBe(replay.semanticWrong);
    expect(study.auc).toBeGreaterThanOrEqual(0);
    expect(study.auc).toBeLessThanOrEqual(1);
  });

  it("finds the gap ranks right serves above wrong ones far better than chance", () => {
    // The readme's claim that a margin has something to work with.
    expect(gapStudy(TRAFFIC, word, 0.5).auc).toBeGreaterThan(0.85);
    expect(gapStudy(TRAFFIC, char, 0.75).auc).toBeGreaterThan(0.9);
  });

  it("scores an empty side at the rocAuc convention 0.5", () => {
    const study = gapStudy(TRAFFIC.slice(0, 5), word, 0.99);
    expect(study.wrong.serves).toBe(0);
    expect(study.auc).toBe(0.5);
  });
});

describe("monotonicity accounting", () => {
  it("counts adjacent rises", () => {
    expect(monotonicityViolations([5, 3, 4, 1])).toBe(1);
    expect(monotonicityViolations([5, 4, 3, 2])).toBe(0);
    expect(monotonicityViolations([1, 2, 3])).toBe(2);
    expect(monotonicityViolations([])).toBe(0);
    expect(monotonicityViolations([7])).toBe(0);
  });
});

describe("full-replay facts the readme quotes", () => {
  const THRESHOLDS = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95];

  it("the naive all scope pays almost entirely in right serves", () => {
    const rows = marginSweep(TRAFFIC, word, 0.75, [0.05], ["all", "differing-answer"]);
    const naive = rows.find((row) => row.scope === "all")!;
    const aware = rows.find((row) => row.scope === "differing-answer")!;
    expect(naive.result.marginRefusals).toBeGreaterThan(100);
    expect(naive.result.refusedRight / naive.result.marginRefusals).toBeGreaterThan(0.95);
    expect(aware.result.marginRefusals).toBeLessThan(10);
    expect(naive.result.savedVsNoCache).toBeLessThan(aware.result.savedVsNoCache - 0.05);
  });

  it("differing-answer margin 0.10 erases char 0.75's wrong serves for about two points of savings", () => {
    const rows = marginSweep(TRAFFIC, char, 0.75, [0.1], ["differing-answer"]);
    const base = rows.find((row) => row.scope === "none")!;
    const margined = rows.find((row) => row.scope === "differing-answer")!;
    expect(base.result.semanticWrong).toBe(34);
    expect(margined.result.semanticWrong).toBe(0);
    expect(base.result.savedVsNoCache - margined.result.savedVsNoCache).toBeLessThan(0.03);
  });

  it("differing-answer margin 0.10 cuts word 0.50's wrong serves hard at small cost", () => {
    const rows = marginSweep(TRAFFIC, word, 0.5, [0.1], ["differing-answer"]);
    const base = rows.find((row) => row.scope === "none")!;
    const margined = rows.find((row) => row.scope === "differing-answer")!;
    expect(base.result.semanticWrong).toBe(93);
    expect(margined.result.semanticWrong).toBeLessThan(20);
    expect(base.result.savedVsNoCache - margined.result.savedVsNoCache).toBeLessThan(0.02);
  });

  it(
    "margin 0.10 removes char's threshold non-monotonicity",
    () => {
      const bare = thresholdSweepUnderMargin(TRAFFIC, char, THRESHOLDS, undefined);
      const margined = thresholdSweepUnderMargin(TRAFFIC, char, THRESHOLDS, differing(0.1));
      expect(monotonicityViolations(bare.map((result) => result.semanticWrong))).toBeGreaterThan(0);
      expect(monotonicityViolations(margined.map((result) => result.semanticWrong))).toBe(0);
    },
    30000,
  );

  it("wrong serves are not monotone in the margin either: char 0.50 rises from 0.15 to 0.20", () => {
    const rows = marginSweep(TRAFFIC, char, 0.5, [0.15, 0.2], ["differing-answer"]);
    const at15 = rows.find((row) => row.margin === 0.15 && row.scope === "differing-answer")!;
    const at20 = rows.find((row) => row.margin === 0.2 && row.scope === "differing-answer")!;
    expect(at20.result.semanticWrong).toBeGreaterThan(at15.result.semanticWrong);
  });

  it(
    "word 0.75 with margin 0.10 beats bare word 0.80 on both axes across all 20 seeds",
    () => {
      const margined = seedSpread(DEFAULT_TRAFFIC, SPREAD_SEEDS, [
        { featurizer: word, threshold: 0.75, marginPolicy: differing(0.1), label: "word m.10" },
      ])[0]!;
      const bare = seedSpread(DEFAULT_TRAFFIC, SPREAD_SEEDS, [{ featurizer: word, threshold: 0.8 }])[0]!;
      expect(margined.wrongMean).toBeLessThan(bare.wrongMean);
      expect(margined.savedMin).toBeGreaterThan(bare.savedMax);
    },
    120000,
  );

  it("a refusal reshapes the store: the margined run gains exact hits the bare run served semantically", () => {
    const bare = runReplay(TRAFFIC, word, 0.75, "word");
    const margined = runReplay(TRAFFIC, word, 0.75, "word", differing(0.2));
    expect(margined.marginRefusals).toBeGreaterThan(0);
    expect(margined.exactHits).toBeGreaterThan(bare.exactHits);
  });
});
