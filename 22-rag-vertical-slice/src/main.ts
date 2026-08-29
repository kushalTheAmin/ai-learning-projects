/**
 * Entry point: start the server on an ephemeral port, then exercise it the
 * way a caller would — one traced request, the golden-set eval across a
 * k sweep, the streaming and backpressure measurements, and the input
 * validation table — printing the numbers the README quotes. Everything
 * here is deterministic: no rng, no wall-clock assertions, all metrics in
 * tokens, dollars, bytes, and counts.
 */

import type { AddressInfo } from "node:net";
import { loadDocs, loadQueries } from "./data.js";
import { createRagServer, QUEUE_CAPACITY } from "./server.js";
import { DocIndex } from "./retrieval.js";
import { answerPieces, answerText } from "./model.js";
import { ask } from "./client.js";
import { evalGolden, type EvalRow } from "./eval.js";
import { runSlowClient } from "./backpressure.js";
import type { WireEvent } from "./stream.js";

function fmt(value: number, digits: number): string {
  return value.toFixed(digits);
}

function pad(value: string | number, width: number): string {
  return String(value).padStart(width);
}

function evalRowLine(row: EvalRow): string {
  return [
    pad(row.k, 2),
    pad(fmt(row.hitAtK, 3), 7),
    pad(fmt(row.answerAccuracy, 3), 7),
    pad(fmt(row.extractionAccuracy, 3), 7),
    pad(row.wrongSentence, 6),
    pad(row.refusedWithGold, 7),
    pad(row.answeredWithoutGold, 7),
    pad(row.refusedWithoutGold, 7),
    pad(fmt(row.meanContextTokens, 1), 9),
    pad(fmt(row.meanTokensIn, 1), 9),
    pad(`$${fmt(row.meanCostUsd, 6)}`, 11),
    pad(`$${fmt(row.totalCostUsd, 4)}`, 9),
  ].join(" ");
}

async function main(): Promise<void> {
  const docs = loadDocs();
  const queries = loadQueries(docs);
  console.log("=== rag vertical slice: question -> retrieve -> scripted model -> sse stream ===");
  console.log(`corpus: ${docs.length} docs, ${queries.length} golden queries (10-chunking-strategies/data)`);
  console.log();

  const { server, log } = createRagServer(docs);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // --- one traced request, wire view ---
    const first = queries[0];
    if (first === undefined) throw new Error("no queries");
    console.log(`--- traced request: POST /ask {"question": "${first.query}", "k": 3} ---`);
    const traced = await ask(baseUrl, { question: first.query, k: 3 });
    if (traced.meta === undefined || traced.usage === undefined) throw new Error("traced request incomplete");
    console.log(`meta      retrieved: ${traced.meta.retrieved.map((r) => `${r.docId}:${fmt(r.score, 4)}`).join("  ")}`);
    console.log(`stream    ${traced.tokenEvents} token events, answer: "${traced.answer}"`);
    console.log(
      `usage     in ${traced.usage.tokensIn} tok (system ${traced.usage.tokensInSystem} + question ${traced.usage.tokensInQuestion} + context ${traced.usage.tokensInContext}), out ${traced.usage.tokensOut} tok, cost $${fmt(traced.usage.costUsd, 6)}`,
    );
    console.log(`log entry ${JSON.stringify(log[log.length - 1])}`);
    console.log();

    // --- golden-set eval across k ---
    console.log(`--- eval hook: ${queries.length} golden queries against the live endpoint, k sweep ---`);
    console.log(" k  hit@k  answer   extr  wrong refused answerd refused   ctx tok    in tok    cost/req  cost/40");
    console.log("             acc      acc   sent  w/gold  no gold no gold");
    const rows: EvalRow[] = [];
    let firstTokenFractions: number[] = [];
    for (const k of [1, 2, 3, 5]) {
      const { row, outcomes } = await evalGolden(baseUrl, queries, k);
      rows.push(row);
      console.log(evalRowLine(row));
      if (k === 3) {
        firstTokenFractions = outcomes
          .filter((o) => o.bytesAtFirstToken !== undefined)
          .map((o) => (o.bytesAtFirstToken as number) / o.wireBytes);
      }
    }
    console.log();
    const k1 = rows[0];
    const k3 = rows[2];
    if (k1 === undefined || k3 === undefined) throw new Error("missing eval rows");
    const categoryLine = Object.entries(k3.byCategory)
      .map(([category, stats]) => `${category} ${fmt(stats.answerAccuracy, 3)} (${stats.queries} queries)`)
      .join(", ");
    console.log(`answer accuracy by category at k=3: ${categoryLine}`);
    console.log(
      `k=1 -> k=3 buys ${fmt(k3.answerAccuracy - k1.answerAccuracy, 3)} answer accuracy for ${fmt(k3.meanTokensIn / k1.meanTokensIn, 2)}x input tokens ($${fmt(k1.totalCostUsd, 4)} -> $${fmt(k3.totalCostUsd, 4)} per 40 questions)`,
    );
    console.log();

    // --- streaming payoff in bytes ---
    const meanFraction = firstTokenFractions.reduce((a, b) => a + b, 0) / firstTokenFractions.length;
    console.log("--- streaming: bytes a client holds before it can render the first token (k=3) ---");
    console.log(
      `first token completes at mean ${fmt(100 * meanFraction, 1)}% of the response bytes (${firstTokenFractions.length}/${queries.length} requests emitted tokens; a buffering client waits for 100% on every one)`,
    );
    console.log();

    // --- backpressure against a slow client ---
    console.log("--- backpressure: slow client (every write blocks one macrotask), bounded vs unbounded queue ---");
    const index = new DocIndex(docs);
    const longest = queries
      .map((q) => answerText(q.query, index.topK(q.query, 3).map((r) => r.doc)))
      .reduce((a, b) => (b.length > a.length ? b : a), "");
    const topDoc = index.topK(first.query, 1)[0];
    if (topDoc === undefined) throw new Error("no docs indexed");
    const dumpText = topDoc.doc.text;
    const cases: [string, string][] = [
      [`longest golden answer (${answerPieces(longest).length} pieces)`, longest],
      [`worst case, model dumps the whole top doc (${answerPieces(dumpText).length} pieces)`, dumpText],
    ];
    for (const [label, text] of cases) {
      const events: WireEvent[] = answerPieces(text).map((piece) => ({
        event: "token",
        data: JSON.stringify({ text: piece }),
      }));
      const unbounded = await runSlowClient("unbounded", events, Infinity);
      const bounded = await runSlowClient(`bounded(${QUEUE_CAPACITY})`, events, QUEUE_CAPACITY);
      console.log(`${label}:`);
      console.log(
        `  unbounded   high-water ${unbounded.highWaterItems} events / ${unbounded.highWaterBytes} bytes buffered, ${unbounded.stalledPushes} stalled pushes`,
      );
      console.log(
        `  bounded(${QUEUE_CAPACITY})  high-water ${bounded.highWaterItems} events / ${bounded.highWaterBytes} bytes buffered, ${bounded.stalledPushes} stalled pushes (producer paced by the client)`,
      );
    }
    console.log();

    // --- input validation ---
    console.log("--- input validation: what the endpoint rejects and how ---");
    const rawPost = async (body: string): Promise<[number, string]> => {
      const response = await fetch(`${baseUrl}/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      const payload = (await response.json()) as { error?: string };
      return [response.status, payload.error ?? ""];
    };
    const checks: [string, () => Promise<[number, string]>][] = [
      ["empty question", async () => rawPost(JSON.stringify({ question: "" }))],
      ["whitespace question", async () => rawPost(JSON.stringify({ question: "   " }))],
      ["question not a string", async () => rawPost(JSON.stringify({ question: 42 }))],
      ["k = 0", async () => rawPost(JSON.stringify({ question: "x", k: 0 }))],
      ["k = 99", async () => rawPost(JSON.stringify({ question: "x", k: 99 }))],
      ["question of 600 chars", async () => rawPost(JSON.stringify({ question: "q".repeat(600) }))],
      ["body not json", async () => rawPost("{nope")],
      ["body of 20 KB", async () => rawPost(JSON.stringify({ question: "q", pad: "x".repeat(20 * 1024) }))],
      [
        "GET /ask",
        async () => {
          const response = await fetch(`${baseUrl}/ask`);
          const payload = (await response.json()) as { error?: string };
          return [response.status, payload.error ?? ""];
        },
      ],
      [
        "POST /nope",
        async () => {
          const response = await fetch(`${baseUrl}/nope`, { method: "POST" });
          const payload = (await response.json()) as { error?: string };
          return [response.status, payload.error ?? ""];
        },
      ],
    ];
    for (const [label, run] of checks) {
      const [status, error] = await run();
      console.log(`  ${label.padEnd(24)} ${status}  ${error}`);
    }
    const unicode = await ask(baseUrl, { question: "où est la sauvegarde nocturne ночью 02:30", k: 3 });
    console.log(`  ${"unicode question".padEnd(24)} ${unicode.status}  streams fine, outcome: ${unicode.outcome}`);
    console.log();

    // --- totals from the server's own log ---
    const totalCost = log.reduce((acc, entry) => acc + entry.usage.costUsd, 0);
    const maxQueueHighWater = log.reduce((acc, entry) => Math.max(acc, entry.queueHighWater), 0);
    console.log("--- request log totals ---");
    console.log(
      `${log.length} requests served, total simulated spend $${fmt(totalCost, 4)}, per-request queue high-water never above ${maxQueueHighWater} (capacity ${QUEUE_CAPACITY})`,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

await main();
