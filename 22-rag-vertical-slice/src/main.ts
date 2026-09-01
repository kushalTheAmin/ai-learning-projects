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
import { computeUsage, createRagServer, QUEUE_CAPACITY } from "./server.js";
import { DocIndex } from "./retrieval.js";
import { answerPieces, answerText, MIN_OVERLAP, scoredAnswer } from "./model.js";
import {
  captureKFacts,
  livePolicyRow,
  oracleRow,
  projectPolicyRow,
  type KCapture,
  type PolicyRow,
} from "./escalate.js";
import { ask } from "./client.js";
import { evalGolden, type EvalRow } from "./eval.js";
import {
  captureScores,
  correctScores,
  liveFloorRow,
  projectFloorRow,
  rocAuc,
  scoreStats,
  sweepThresholds,
  wrongScores,
  youdenBest,
  type FloorRow,
  type ScoredQuery,
} from "./floorsweep.js";
import { runSlowClient } from "./backpressure.js";
import { serializeEvent, type QueueLimit, type WireEvent } from "./stream.js";

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

    // --- refusal floor sweep ---
    console.log("--- refusal floor sweep at k=3: what the 0.35 overlap floor buys and costs ---");
    const withFloorServer = async <T>(floor: number, run: (url: string) => Promise<T>): Promise<T> => {
      const floorRag = createRagServer(docs, { minOverlap: floor });
      await new Promise<void>((resolve) => floorRag.server.listen(0, "127.0.0.1", resolve));
      const floorUrl = `http://127.0.0.1:${(floorRag.server.address() as AddressInfo).port}`;
      try {
        return await run(floorUrl);
      } finally {
        floorRag.server.closeAllConnections();
        await new Promise<void>((resolve, reject) => floorRag.server.close((err) => (err ? reject(err) : resolve())));
      }
    };

    const floor0K3 = await withFloorServer(0, async (url) => (await evalGolden(url, queries, 3)).outcomes);
    const scored: ScoredQuery[] = captureScores(floor0K3);
    const positives = correctScores(scored);
    const negatives = wrongScores(scored);
    const posStats = scoreStats(positives);
    const negStats = scoreStats(negatives);
    console.log(
      `overlap score as a confidence signal: correct answers ${posStats.count} (score min ${fmt(posStats.min, 3)} mean ${fmt(posStats.mean, 3)} max ${fmt(posStats.max, 3)}), wrong answers ${negStats.count} (min ${fmt(negStats.min, 3)} mean ${fmt(negStats.mean, 3)} max ${fmt(negStats.max, 3)})`,
    );
    console.log(`roc-auc (correct vs wrong, mann-whitney with ties at half credit): ${fmt(rocAuc(positives, negatives), 3)}`);
    const noGoldMax = Math.max(...scored.filter((s) => !s.hit).map((s) => s.bestOverlap));
    console.log(`highest score among wrong-doc best sentences: ${fmt(noGoldMax, 3)} (any floor above it keeps answered-without-gold at 0)`);
    const best = youdenBest(sweepThresholds(positives, negatives));
    console.log(
      `youden-best floor over observed scores: ${fmt(best.threshold, 3)} (keeps ${fmt(best.recall, 3)} of correct answers, ${fmt(best.fpr, 3)} of wrong ones, precision ${fmt(best.precision, 3)})`,
    );
    console.log();
    console.log("floor  answrd refusd  answer     acc|  wrong  answrd refused");
    console.log("                         acc  answrd    ans  nogold correct");
    const floors = [0, 0.15, 0.25, 0.35, 0.45, 0.5, 0.55, 0.65, 0.75, 1.0];
    for (const floor of floors) {
      const live: FloorRow = await withFloorServer(floor, async (url) => {
        const { outcomes } = await evalGolden(url, queries, 3);
        return liveFloorRow(outcomes, scored, floor);
      });
      const projected = projectFloorRow(scored, floor);
      if (JSON.stringify(live) !== JSON.stringify(projected)) {
        throw new Error(`floor ${floor}: live endpoint row diverges from the floor-0 projection`);
      }
      console.log(
        [
          pad(fmt(floor, 2), 5),
          pad(live.answered, 7),
          pad(live.refused, 6),
          pad(fmt(live.answerAccuracy, 3), 8),
          pad(fmt(live.accuracyAmongAnswered, 3), 8),
          pad(live.wrongAnswered, 7),
          pad(live.answeredWithoutGold, 7),
          pad(live.refusedWouldBeCorrect, 7),
        ].join(""),
      );
    }
    console.log("every live row above equals its floor-0 projection exactly (checked per floor)");
    console.log();

    // --- score-gated escalation ---
    console.log("--- score-gated escalation: retry retrieval at a wider k only where the k=3 score is low ---");
    const capK3: KCapture[] = captureKFacts(floor0K3);
    const capByK2 = new Map<number, KCapture[]>();
    for (const k2 of [5, 10]) {
      capByK2.set(
        k2,
        captureKFacts(await withFloorServer(0, async (url) => (await evalGolden(url, queries, k2)).outcomes)),
      );
    }

    const pool = capK3.filter((c) => c.bestOverlap < MIN_OVERLAP);
    const poolMisses = pool.filter((c) => !c.hit);
    console.log(
      `escalation pool at trigger ${fmt(MIN_OVERLAP, 2)} (the shipped floor): ${pool.length} of ${capK3.length} queries score under it at k=3, split ${poolMisses.length} retrieval misses (the only class a wider k can convert) and ${pool.length - poolMisses.length} with the gold doc already in context, where widening cannot move the gold sentence's score`,
    );
    const convertible = (k2: number): number => {
      const byId = new Map((capByK2.get(k2) as KCapture[]).map((c) => [c.queryId, c]));
      return poolMisses.filter((c) => {
        const c2 = byId.get(c.queryId) as KCapture;
        return c2.bestOverlap >= MIN_OVERLAP && c2.wouldCorrect;
      }).length;
    };
    console.log(
      `of the ${poolMisses.length} misses, a wider context actually converts ${convertible(5)} at k2=5 and ${convertible(10)} at k2=10 (gold doc arrives AND its sentence wins AND clears the floor)`,
    );
    console.log();

    const fixedRows = new Map<number, EvalRow>([[3, k3]]);
    const k5Row = rows[3];
    if (k5Row === undefined) throw new Error("missing k=5 eval row");
    fixedRows.set(5, k5Row);
    fixedRows.set(10, (await evalGolden(baseUrl, queries, 10)).row);

    console.log("policy               escal helped hurt  answrd  answer  mean in    cost/40  vs fixed");
    console.log("                                        nogold     acc      tok             k2 cost");
    const policyLine = (label: string, row: PolicyRow, fixedCost: number): string =>
      [
        label.padEnd(20),
        pad(row.escalated, 6),
        pad(row.helped, 6),
        pad(row.hurt, 5),
        pad(row.answeredWithoutGold, 7),
        pad(fmt(row.answerAccuracy, 3), 8),
        pad(fmt(row.meanTokensIn, 1), 9),
        pad(`$${fmt(row.totalCostUsd, 4)}`, 10),
        pad(`${fmt((100 * row.totalCostUsd) / fixedCost, 1)}%`, 9),
      ].join(" ");
    const fixedLine = (k: number): string => {
      const row = fixedRows.get(k) as EvalRow;
      return [
        `fixed k=${k}`.padEnd(20),
        pad(0, 6),
        pad("-", 6),
        pad("-", 5),
        pad(row.answeredWithoutGold, 7),
        pad(fmt(row.answerAccuracy, 3), 8),
        pad(fmt(row.meanTokensIn, 1), 9),
        pad(`$${fmt(row.totalCostUsd, 4)}`, 10),
        pad("-", 9),
      ].join(" ");
    };
    console.log(fixedLine(3));
    for (const k2 of [5, 10]) {
      const capK2 = capByK2.get(k2) as KCapture[];
      const fixedCost = (fixedRows.get(k2) as EvalRow).totalCostUsd;
      console.log(fixedLine(k2));
      for (const trigger of [0.35, 0.45, 0.55, 0.75, Infinity]) {
        const row = projectPolicyRow(capK3, capK2, MIN_OVERLAP, { trigger, k2 });
        const label = trigger === Infinity ? `  k2=${k2} always` : `  k2=${k2} trig ${fmt(trigger, 2)}`;
        console.log(policyLine(label, row, fixedCost));
      }
      console.log(policyLine(`  k2=${k2} oracle`, oracleRow(capK3, capK2, MIN_OVERLAP, k2), fixedCost));
    }
    console.log();

    const pinned: { policy: { trigger: number; k2: number }; label: string }[] = [
      { policy: { trigger: 0.35, k2: 10 }, label: "trigger 0.35, k2=10" },
      { policy: { trigger: 0.45, k2: 5 }, label: "trigger 0.45, k2=5" },
    ];
    for (const { policy, label } of pinned) {
      const capK2 = capByK2.get(policy.k2) as KCapture[];
      const projected = projectPolicyRow(capK3, capK2, MIN_OVERLAP, policy);
      const escalationRag = createRagServer(docs, { escalation: policy });
      await new Promise<void>((resolve) => escalationRag.server.listen(0, "127.0.0.1", resolve));
      const escalationUrl = `http://127.0.0.1:${(escalationRag.server.address() as AddressInfo).port}`;
      try {
        const { outcomes } = await evalGolden(escalationUrl, queries, 3);
        const live = livePolicyRow(outcomes, capK3, MIN_OVERLAP, policy);
        if (JSON.stringify(live) !== JSON.stringify(projected)) {
          throw new Error(`escalation policy ${label}: live endpoint row diverges from the projection`);
        }
      } finally {
        escalationRag.server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          escalationRag.server.close((err) => (err ? reject(err) : resolve())),
        );
      }
    }
    console.log(`live escalation servers reproduce their projected rows exactly (checked: ${pinned.map((p) => p.label).join("; ")})`);

    const escalate10 = projectPolicyRow(capK3, capByK2.get(10) as KCapture[], MIN_OVERLAP, { trigger: 0.35, k2: 10 });
    const fixed10 = fixedRows.get(10) as EvalRow;
    console.log(
      `headline: trigger ${fmt(MIN_OVERLAP, 2)} escalation to k=10 reaches accuracy ${fmt(escalate10.answerAccuracy, 3)} vs fixed k=10's ${fmt(fixed10.answerAccuracy, 3)} at ${fmt((100 * escalate10.totalCostUsd) / fixed10.totalCostUsd, 1)}% of its cost ($${fmt(escalate10.totalCostUsd, 4)} vs $${fmt(fixed10.totalCostUsd, 4)} per 40), but ${escalate10.escalated - escalate10.helped} of its ${escalate10.escalated} escalations buy nothing, which is the gap the oracle row prices`,
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
    console.log("--- backpressure: slow client (every write blocks one macrotask), event cap vs byte budget ---");
    const index = new DocIndex(docs);
    const longestCase = queries
      .map((q) => ({ query: q.query, answer: answerText(q.query, index.topK(q.query, 3).map((r) => r.doc)) }))
      .reduce((a, b) => (b.answer.length > a.answer.length ? b : a));
    const topDoc = index.topK(first.query, 1)[0];
    if (topDoc === undefined) throw new Error("no docs indexed");
    const requestEvents = (question: string, answer: string): WireEvent[] => {
      const retrieved = index.topK(question, 3);
      const context = retrieved.map((r) => r.doc);
      return [
        {
          event: "meta",
          data: JSON.stringify({
            requestId: "r0001",
            k: 3,
            retrieved: retrieved.map((r) => ({ docId: r.doc.id, score: Number(r.score.toFixed(4)) })),
          }),
        },
        ...answerPieces(answer).map((piece) => ({ event: "token", data: JSON.stringify({ text: piece }) })),
        {
          event: "done",
          data: JSON.stringify({
            outcome: "answered",
            bestOverlap: scoredAnswer(question, context).bestOverlap,
            usage: computeUsage(question, context, answer),
          }),
        },
      ];
    };
    const cases: [string, WireEvent[]][] = [
      ["longest golden answer", requestEvents(longestCase.query, longestCase.answer)],
      ["worst case, model dumps the whole top doc", requestEvents(first.query, topDoc.doc.text)],
    ];
    const limits: [string, QueueLimit][] = [
      ["unbounded", Infinity],
      [`events-${QUEUE_CAPACITY}`, QUEUE_CAPACITY],
      ["bytes-512", { maxBytes: 512 }],
      ["bytes-128", { maxBytes: 128 }],
    ];
    for (const [label, events] of cases) {
      const wire = events.map((event) => serializeEvent(event).length);
      const tokenSizes = wire.slice(1, -1);
      console.log(
        `${label}: ${events.length} events / ${wire.reduce((a, b) => a + b, 0)} wire bytes (meta ${wire[0]} B, tokens ${Math.min(...tokenSizes)}-${Math.max(...tokenSizes)} B, done ${wire[wire.length - 1]} B)`,
      );
      for (const [limitLabel, limit] of limits) {
        const run = await runSlowClient(limitLabel, events, limit);
        console.log(
          `  ${limitLabel.padEnd(10)} high-water ${pad(run.highWaterItems, 3)} events / ${pad(run.highWaterBytes, 5)} bytes buffered, ${pad(run.stalledPushes, 3)} stalled pushes, ${run.oversizedPushes} oversized admissions`,
        );
      }
    }
    console.log();

    // --- live server on a byte budget: same behavior, bytes pinned ---
    const byteBudget = 1024;
    const byteRag = createRagServer(docs, { queue: { maxBytes: byteBudget } });
    await new Promise<void>((resolve) => byteRag.server.listen(0, "127.0.0.1", resolve));
    const byteUrl = `http://127.0.0.1:${(byteRag.server.address() as AddressInfo).port}`;
    try {
      const { row: byteRow } = await evalGolden(byteUrl, queries, 3);
      if (JSON.stringify(byteRow) !== JSON.stringify(k3)) {
        throw new Error("byte-budget server eval row diverges from the event-cap server");
      }
      const maxBytesHigh = byteRag.log.reduce((acc, entry) => Math.max(acc, entry.queueHighWaterBytes), 0);
      const oversizedTotal = byteRag.log.reduce((acc, entry) => acc + entry.queueOversizedPushes, 0);
      console.log(
        `live /ask on queue {maxBytes: ${byteBudget}}: k=3 eval row identical to the event-cap server (checked field by field), queue high-water ${maxBytesHigh} bytes and ${oversizedTotal} oversized admissions across ${byteRag.log.length} requests — with a fast local client the budget currency changes nothing observable`,
      );
    } finally {
      byteRag.server.closeAllConnections();
      await new Promise<void>((resolve, reject) => byteRag.server.close((err) => (err ? reject(err) : resolve())));
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
    const maxQueueHighWaterBytes = log.reduce((acc, entry) => Math.max(acc, entry.queueHighWaterBytes), 0);
    console.log("--- request log totals ---");
    console.log(
      `${log.length} requests served, total simulated spend $${fmt(totalCost, 4)}, per-request queue high-water never above ${maxQueueHighWater} events / ${maxQueueHighWaterBytes} bytes (capacity ${QUEUE_CAPACITY} events)`,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

await main();
