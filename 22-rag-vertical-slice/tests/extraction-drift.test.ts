/**
 * Why extraction accuracy does not climb with hit@k.
 *
 * The k sweep's reading blamed the drift on the extra docs: "every extra
 * doc is another set of distractor sentences for the best-overlap pick to
 * lose to". That is a claim about picks being stolen — a query that read
 * correctly at one k reading wrong at a wider one — and it never happens
 * on this corpus. The escalation plane already measured the same thing
 * from the other side (18 correct answers escalate under always-escalate
 * and hurt reads 0), and the readme's own open questions say the gold
 * sentence wins every wider contest it was winning at k=3. The sweep
 * paragraph asserted the mechanism those rows rule out.
 *
 * The drift is a denominator effect: the gold docs that only arrive at a
 * wider k are answered right less often than the ones retrieved at k=1,
 * so each widening step adds more denominator than numerator.
 *
 * These tests pin that no pick is ever stolen, pin the decomposition on
 * the committed golden set, and hold all three surfaces that published the
 * retired mechanism to the measured one.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { loadDocs, loadQueries } from "../src/data.js";
import { createRagServer } from "../src/server.js";
import { evalGolden, extractionDrift, type QueryOutcome } from "../src/eval.js";

const docs = loadDocs();
const queries = loadQueries(docs);

const README = new URL("../README.md", import.meta.url);
const ROOT_README = new URL("../../README.md", import.meta.url);
const PROGRESS = new URL("../../progress.md", import.meta.url);

/** Collapse whitespace: a claim that wraps across lines must still match. */
function squash(text: string): string {
  return text.replace(/\s+/g, " ");
}

/** The retired mechanism, in the spellings the three surfaces used. */
const RETIRED = [
  "every extra doc is another set of distractor sentences for the best-overlap pick to lose to",
  "every extra doc is another set of distractor sentences",
  "slips as every extra doc adds distractor sentences",
];

describe("the k sweep's drift is a denominator effect, not stolen picks", () => {
  const sweep = [1, 2, 3, 5];
  let byK: Map<number, QueryOutcome[]>;

  beforeAll(async () => {
    const rag = createRagServer(docs);
    await new Promise<void>((resolve) => rag.server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(rag.server.address() as AddressInfo).port}`;
    try {
      byK = new Map();
      for (const k of sweep) byK.set(k, (await evalGolden(url, queries, k)).outcomes);
    } finally {
      rag.server.closeAllConnections();
      await new Promise<void>((resolve, reject) => rag.server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it("no query reads correctly at one k and wrong at a wider one", () => {
    expect(extractionDrift(byK).stolenPicks).toBe(0);
  });

  it("holds over every pair in the sweep, not just the ends", () => {
    for (const narrow of sweep) {
      for (const wide of sweep) {
        if (wide <= narrow) continue;
        const was = new Map((byK.get(narrow) as QueryOutcome[]).map((o) => [o.queryId, o.correct]));
        const lost = (byK.get(wide) as QueryOutcome[]).filter((o) => was.get(o.queryId) === true && !o.correct);
        expect(lost.map((o) => o.queryId), `k=${narrow} -> k=${wide}`).toEqual([]);
      }
    }
  });

  it("attributes the drift to which gold docs arrive late", () => {
    const drift = extractionDrift(byK);
    // the gold docs retrieved at k=1, and the ones that only show up later
    expect(drift.earlyHits).toBe(26);
    expect(drift.earlyCorrect).toBe(14);
    expect(drift.lateHits).toBe(12);
    expect(drift.lateCorrect).toBe(5);
    // the late arrivals read right less often, which is the whole drift
    expect(drift.lateCorrect / drift.lateHits).toBeLessThan(drift.earlyCorrect / drift.earlyHits);
  });

  it("the decomposition adds back up to the widest row's extraction accuracy", () => {
    const drift = extractionDrift(byK);
    const widest = (byK.get(5) as QueryOutcome[]);
    const hits = widest.filter((o) => o.hit).length;
    const correct = widest.filter((o) => o.correct).length;
    expect(drift.earlyHits + drift.lateHits).toBe(hits);
    expect(drift.earlyCorrect + drift.lateCorrect).toBe(correct);
  });

  it("counts a stolen pick when one actually happens", () => {
    // the measure has to be able to fire, or a 0 from it means nothing
    const fake = (correct: boolean): QueryOutcome[] => [
      {
        queryId: "q01",
        category: "keyword",
        hit: true,
        correct,
        served: "answered",
        bestOverlap: 0.5,
        usage: { tokensInSystem: 1, tokensInQuestion: 1, tokensInContext: 1, tokensIn: 3, tokensOut: 1, costUsd: 0 },
        wireBytes: 10,
        bytesAtFirstToken: 5,
      },
    ];
    expect(extractionDrift(new Map([[1, fake(true)], [3, fake(false)]])).stolenPicks).toBe(1);
    expect(extractionDrift(new Map([[1, fake(false)], [3, fake(true)]])).stolenPicks).toBe(0);
  });
});

describe("the readme reads the drift off what was measured", () => {
  const body = squash(readFileSync(README, "utf-8")).split("## fixes")[0] as string;

  it("no longer blames the extra docs for stealing the pick", () => {
    for (const claim of RETIRED) expect(body).not.toContain(claim);
  });

  it("names the stolen pick as the thing that never happens", () => {
    expect(body).toContain("no query that reads correctly at one k reads wrong at a wider one");
  });

  it("names the late-arriving gold docs as the mechanism, with the counts", () => {
    expect(body).toContain("5 of the 12 gold docs that only arrive past k=1 are answered right, against 14 of the first 26");
  });

  it("ties the reading to the escalation plane that rules the steal out", () => {
    expect(body).toContain("atrisk 18 / hurt 0");
  });
});

describe("the other two surfaces that published the retired mechanism", () => {
  it("the root readme's index row does not carry it", () => {
    expect(squash(readFileSync(ROOT_README, "utf-8"))).not.toContain(RETIRED[1] as string);
  });

  it("progress.md's ledger row does not carry it", () => {
    expect(squash(readFileSync(PROGRESS, "utf-8"))).not.toContain(RETIRED[2] as string);
  });
});
