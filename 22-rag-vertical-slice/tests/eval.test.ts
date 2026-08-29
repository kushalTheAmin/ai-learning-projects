import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { loadDocs, loadQueries } from "../src/data.js";
import { createRagServer, type RagServer } from "../src/server.js";
import { evalGolden } from "../src/eval.js";

const docs = loadDocs();
const queries = loadQueries(docs);

let rag: RagServer;
let baseUrl: string;

beforeAll(async () => {
  rag = createRagServer(docs);
  await new Promise<void>((resolve) => rag.server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(rag.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  rag.server.closeAllConnections();
  await new Promise<void>((resolve, reject) => rag.server.close((err) => (err ? reject(err) : resolve())));
});

describe("evalGolden", () => {
  it("partitions every query into exactly one outcome bucket", async () => {
    const { row, outcomes } = await evalGolden(baseUrl, queries, 3);
    expect(row.queries).toBe(40);
    const correct = outcomes.filter((o) => o.correct).length;
    expect(
      correct + row.wrongSentence + row.refusedWithGold + row.answeredWithoutGold + row.refusedWithoutGold,
    ).toBe(40);
  });

  it("only credits answers whose gold doc was retrieved (answers are corpus-unique)", async () => {
    const { outcomes } = await evalGolden(baseUrl, queries, 3);
    for (const outcome of outcomes) {
      if (outcome.correct) expect(outcome.hit).toBe(true);
    }
  });

  it("finds a real accuracy on the committed golden set at k=3", async () => {
    const { row } = await evalGolden(baseUrl, queries, 3);
    expect(row.hitAtK).toBeGreaterThan(0.8);
    expect(row.answerAccuracy).toBeGreaterThan(0.3);
    expect(row.answerAccuracy).toBeLessThan(1);
    expect(row.answerAccuracy).toBeLessThanOrEqual(row.hitAtK);
  });

  it("retrieval is perfect at k=10 and extraction equals answer accuracy there", async () => {
    const { row } = await evalGolden(baseUrl, queries, 10);
    expect(row.hitAtK).toBe(1);
    expect(row.extractionAccuracy).toBe(row.answerAccuracy);
    expect(row.answeredWithoutGold).toBe(0);
    expect(row.refusedWithoutGold).toBe(0);
  });

  it("splits accuracy by category over the whole set", async () => {
    const { row } = await evalGolden(baseUrl, queries, 3);
    const total = Object.values(row.byCategory).reduce((acc, c) => acc + c.queries, 0);
    expect(total).toBe(40);
    expect(Object.keys(row.byCategory).sort()).toEqual(["keyword", "paraphrase"]);
  });

  it("costs strictly more per request at larger k", async () => {
    const one = await evalGolden(baseUrl, queries, 1);
    const five = await evalGolden(baseUrl, queries, 5);
    expect(five.row.meanTokensIn).toBeGreaterThan(one.row.meanTokensIn);
    expect(five.row.meanCostUsd).toBeGreaterThan(one.row.meanCostUsd);
    expect(five.row.hitAtK).toBeGreaterThanOrEqual(one.row.hitAtK);
  });
});
