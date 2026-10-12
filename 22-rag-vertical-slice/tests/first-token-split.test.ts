/**
 * The first-token byte fraction, held to the population it describes.
 *
 * The streaming section asks how much of a response a client must hold
 * before it can render anything, and published one mean over all 40
 * responses. But 12 of those 40 are refusals, and a refusal is not a
 * streamed answer: it is the same fixed 46-character string every time, so
 * its first token lands at a near-constant share of a near-constant
 * response. Pooling it with the 28 extracted sentences averages a measured
 * quantity against an authored constant, and the constant is the larger of
 * the two — it pulled the headline up from 18.6% to 22.6%, making the
 * streaming payoff on real answers look worse than it is.
 *
 * `firstTokenSplit` separates the two populations. These tests pin the
 * separation on the committed golden set, show the measure can fire on
 * synthetic outcomes, and hold both readmes to the split claim.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { loadDocs, loadQueries } from "../src/data.js";
import { createRagServer } from "../src/server.js";
import { evalGolden, firstTokenSplit, type QueryOutcome } from "../src/eval.js";

const docs = loadDocs();
const queries = loadQueries(docs);

const README = new URL("../README.md", import.meta.url);
const ROOT_README = new URL("../../README.md", import.meta.url);

/** Collapse whitespace: a claim that wraps across lines must still match. */
function squash(text: string): string {
  return text.replace(/\s+/g, " ");
}

/** The pooled-only readings this fix retired, on both surfaces. */
const RETIRED = [
  "the first token completes at a mean 22.6% of the response bytes at k=3",
  "a streaming client renders its first token at a mean 22.6% of the response bytes",
];

function outcome(overrides: Partial<QueryOutcome>): QueryOutcome {
  return {
    queryId: "q",
    category: "keyword",
    hit: true,
    correct: true,
    served: "answered",
    bestOverlap: 0.5,
    usage: { tokensInSystem: 1, tokensInQuestion: 1, tokensInContext: 1, tokensIn: 3, tokensOut: 1, costUsd: 0 },
    wireBytes: 1000,
    bytesAtFirstToken: 100,
    ...overrides,
  };
}

describe("firstTokenSplit separates a streamed answer from a canned refusal", () => {
  it("reports each population and the pooled figure", () => {
    const split = firstTokenSplit([
      outcome({ queryId: "a", served: "answered", wireBytes: 1000, bytesAtFirstToken: 100 }),
      outcome({ queryId: "b", served: "answered", wireBytes: 1000, bytesAtFirstToken: 300 }),
      outcome({ queryId: "c", served: "refused", wireBytes: 1000, bytesAtFirstToken: 500 }),
    ]);
    expect(split.answered).toEqual({ count: 2, mean: 0.2, min: 0.1, max: 0.3 });
    expect(split.refused).toEqual({ count: 1, mean: 0.5, min: 0.5, max: 0.5 });
    expect(split.pooled).toEqual({ count: 3, mean: 0.3, min: 0.1, max: 0.5 });
  });

  it("pooling is what moves the number, so the measure can fire", () => {
    // refusals above the answered range drag the pooled mean up
    const dragged = firstTokenSplit([
      outcome({ served: "answered", bytesAtFirstToken: 100 }),
      outcome({ served: "refused", bytesAtFirstToken: 900 }),
    ]);
    expect(dragged.answered.mean).toBeCloseTo(0.1, 10);
    expect(dragged.pooled.mean).toBeCloseTo(0.5, 10);
  });

  it("skips responses that never emitted a token", () => {
    const split = firstTokenSplit([
      outcome({ served: "answered", bytesAtFirstToken: 200 }),
      outcome({ served: "answered", bytesAtFirstToken: undefined }),
    ]);
    expect(split.answered.count).toBe(1);
    expect(split.pooled.count).toBe(1);
  });

  it("an empty population reports no fraction rather than a zero", () => {
    const split = firstTokenSplit([outcome({ served: "answered", bytesAtFirstToken: 100 })]);
    expect(split.refused.count).toBe(0);
    expect(Number.isNaN(split.refused.mean)).toBe(true);
  });
});

describe("the committed golden set: two populations, not one", () => {
  let split: ReturnType<typeof firstTokenSplit>;

  beforeAll(async () => {
    const rag = createRagServer(docs);
    await new Promise<void>((resolve) => rag.server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(rag.server.address() as AddressInfo).port}`;
    try {
      split = firstTokenSplit((await evalGolden(url, queries, 3)).outcomes);
    } finally {
      rag.server.closeAllConnections();
      await new Promise<void>((resolve, reject) => rag.server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it("splits 28 answered against 12 refusals at k=3", () => {
    expect(split.answered.count).toBe(28);
    expect(split.refused.count).toBe(12);
    expect(split.pooled.count).toBe(queries.length);
  });

  it("the refusals are a constant, not a measurement: their spread is under two points", () => {
    expect(100 * (split.refused.max - split.refused.min)).toBeLessThan(2);
    // the answered responses vary by more than twenty
    expect(100 * (split.answered.max - split.answered.min)).toBeGreaterThan(20);
  });

  it("every refusal lands above the answered mean, so pooling can only drag it up", () => {
    expect(split.refused.min).toBeGreaterThan(split.answered.mean);
    expect(split.pooled.mean).toBeGreaterThan(split.answered.mean);
  });

  it("pins the published figures: 18.6% answered, 22.6% pooled", () => {
    expect((100 * split.answered.mean).toFixed(1)).toBe("18.6");
    expect((100 * split.pooled.mean).toFixed(1)).toBe("22.6");
    expect((100 * split.refused.min).toFixed(1)).toBe("31.3");
    expect((100 * split.refused.max).toFixed(1)).toBe("33.2");
  });

  it("the gap the pooled reading hid is four points", () => {
    expect(100 * (split.pooled.mean - split.answered.mean)).toBeGreaterThan(3.5);
  });
});

describe("the readmes report the fraction over the answers it describes", () => {
  const body = squash(readFileSync(README, "utf-8")).split("## fixes")[0] as string;

  it("no longer publishes the pooled mean as the streaming payoff", () => {
    expect(body).not.toContain(RETIRED[0] as string);
  });

  it("headlines the answered population with its count", () => {
    expect(body).toContain("first token completes at a mean 18.6% of the response bytes on the 28 answered responses");
  });

  it("names the refusals as a fixed string with a near-constant fraction", () => {
    expect(body).toContain("the 12 refusals stream a fixed string");
    expect(body).toContain("31.3-33.2%");
  });

  it("keeps the pooled figure, labelled as the pooled one", () => {
    expect(body).toContain("pooling all 40 reads 22.6%");
  });

  it("the root readme's index row does not carry the pooled-only claim", () => {
    expect(squash(readFileSync(ROOT_README, "utf-8"))).not.toContain(RETIRED[1] as string);
  });
});
