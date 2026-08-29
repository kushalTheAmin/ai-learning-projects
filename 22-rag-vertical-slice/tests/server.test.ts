import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { loadDocs, loadQueries, type GoldenQuery } from "../src/data.js";
import { answerPieces } from "../src/model.js";
import {
  computeUsage,
  createRagServer,
  parseAskBody,
  MAX_K,
  type RagServer,
} from "../src/server.js";
import { DocIndex } from "../src/retrieval.js";
import { ask } from "../src/client.js";

const docs = loadDocs();
const queries = loadQueries(docs);
const q01 = queries.find((q) => q.id === "q01") as GoldenQuery;

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

describe("POST /ask", () => {
  it("streams meta, tokens, and done for a golden question", async () => {
    const result = await ask(baseUrl, { question: q01.query, k: 3 });
    expect(result.status).toBe(200);
    expect(result.meta?.retrieved).toHaveLength(3);
    expect(result.meta?.retrieved[0]?.docId).toBe(q01.docId);
    expect(result.outcome).toBe("answered");
    expect(result.answer).toContain(q01.answer);
    expect(result.tokenEvents).toBe(answerPieces(result.answer).length);
  });

  it("reports usage that matches an independent recomputation", async () => {
    const result = await ask(baseUrl, { question: q01.query, k: 2 });
    const context = new DocIndex(docs).topK(q01.query, 2).map((r) => r.doc);
    const expected = computeUsage(q01.query, context, result.answer);
    expect(result.usage).toEqual(expected);
    expect(result.usage!.tokensIn).toBe(
      result.usage!.tokensInSystem + result.usage!.tokensInQuestion + result.usage!.tokensInContext,
    );
  });

  it("delivers the exact bytes the events serialize to", async () => {
    const result = await ask(baseUrl, { question: q01.query, k: 1 });
    expect(result.totalBytes).toBe(result.wireBytes);
    expect(result.bytesAtFirstToken).toBeGreaterThan(0);
    expect(result.bytesAtFirstToken!).toBeLessThan(result.wireBytes);
  });

  it("defaults k to 3 when omitted", async () => {
    const result = await ask(baseUrl, { question: q01.query });
    expect(result.meta?.k).toBe(3);
    expect(result.meta?.retrieved).toHaveLength(3);
  });

  it("logs every request with the bytes it sent", async () => {
    const before = rag.log.length;
    const result = await ask(baseUrl, { question: q01.query, k: 3 });
    expect(rag.log).toHaveLength(before + 1);
    const entry = rag.log[rag.log.length - 1]!;
    expect(entry.requestId).toBe(result.meta?.requestId);
    expect(entry.retrieved).toEqual(result.meta?.retrieved.map((r) => r.docId));
    expect(entry.bytes).toBe(result.totalBytes);
    expect(entry.events).toBe(result.tokenEvents + 2);
    expect(entry.usage).toEqual(result.usage);
  });

  it("serves concurrent requests with distinct request ids", async () => {
    const three = queries.slice(0, 3);
    const results = await Promise.all(three.map((q) => ask(baseUrl, { question: q.query, k: 2 })));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const ids = new Set(results.map((r) => r.meta?.requestId));
    expect(ids.size).toBe(3);
  });

  it("streams a refusal for a question the corpus cannot answer", async () => {
    const result = await ask(baseUrl, { question: "qui a gagné la coupe du monde 1998", k: 3 });
    expect(result.status).toBe(200);
    expect(result.outcome).toBe("refused");
    expect(result.tokenEvents).toBeGreaterThan(0);
  });

  it("rejects an empty question with 400", async () => {
    const result = await ask(baseUrl, { question: "  " });
    expect(result.status).toBe(400);
    expect(result.error).toContain("must not be empty");
  });

  it("rejects a non-string question with 400", async () => {
    const result = await ask(baseUrl, { question: 42 });
    expect(result.status).toBe(400);
  });

  it("rejects an out-of-range k with 400", async () => {
    expect((await ask(baseUrl, { question: "x", k: 0 })).status).toBe(400);
    expect((await ask(baseUrl, { question: "x", k: 11 })).status).toBe(400);
    expect((await ask(baseUrl, { question: "x", k: 2.5 })).status).toBe(400);
  });

  it("rejects an oversized question with 413", async () => {
    const result = await ask(baseUrl, { question: "q".repeat(501) });
    expect(result.status).toBe(413);
  });

  it("rejects a body that is not json with 400", async () => {
    const response = await fetch(`${baseUrl}/ask`, { method: "POST", body: "{nope" });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("valid json");
  });

  it("rejects a json array body with 400", async () => {
    const response = await fetch(`${baseUrl}/ask`, { method: "POST", body: "[1,2]" });
    expect(response.status).toBe(400);
  });

  it("rejects an oversized body with 413", async () => {
    const response = await fetch(`${baseUrl}/ask`, {
      method: "POST",
      body: JSON.stringify({ question: "x", pad: "y".repeat(20 * 1024) }),
    });
    expect(response.status).toBe(413);
  });

  it("rejects GET /ask with 405 and unknown paths with 404", async () => {
    expect((await fetch(`${baseUrl}/ask`)).status).toBe(405);
    expect((await fetch(`${baseUrl}/nope`, { method: "POST" })).status).toBe(404);
  });

  it("answers a unicode question with a well-formed stream", async () => {
    const result = await ask(baseUrl, { question: "où est la sauvegarde nocturne ночью", k: 2 });
    expect(result.status).toBe(200);
    expect(result.outcome).toBeDefined();
    expect(result.totalBytes).toBe(result.wireBytes);
  });
});

describe("GET /healthz", () => {
  it("reports the corpus size", async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; docs: number };
    expect(body.ok).toBe(true);
    expect(body.docs).toBe(10);
  });
});

describe("parseAskBody", () => {
  it("accepts boundary k values", () => {
    expect(parseAskBody(JSON.stringify({ question: "x", k: 1 }), MAX_K)).toEqual({ question: "x", k: 1 });
    expect(parseAskBody(JSON.stringify({ question: "x", k: 10 }), MAX_K)).toEqual({ question: "x", k: 10 });
  });

  it("ignores extra fields and trims the question", () => {
    expect(parseAskBody(JSON.stringify({ question: " x ", verbose: true }), MAX_K)).toEqual({
      question: "x",
      k: 3,
    });
  });
});
