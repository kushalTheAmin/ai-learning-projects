/**
 * The endpoint. POST /ask takes {question, k?}, retrieves top-k docs,
 * streams the scripted model's answer as SSE (meta, token..., done), and
 * logs tokens and dollars for every request it serves. Input validation is
 * strict and each rejection names what was wrong; the request log is the
 * server's own accounting, one entry per request, queryable by the caller
 * that owns the server.
 */

import { createServer, type Server, type ServerResponse } from "node:http";
import { costUsd, estimateTokens } from "../../08-agent-tool-loop/src/messages.js";
import type { Doc } from "./data.js";
import { answerPieces, MIN_OVERLAP, REFUSAL, scoredAnswer, SYSTEM_PROMPT } from "./model.js";
import { DocIndex } from "./retrieval.js";
import { streamEvents, type StreamSink, type WireEvent } from "./stream.js";

export const MAX_QUESTION_CHARS = 500;
export const MAX_BODY_BYTES = 16 * 1024;
export const DEFAULT_K = 3;
export const MAX_K = 10;
export const QUEUE_CAPACITY = 8;

export interface Usage {
  tokensInSystem: number;
  tokensInQuestion: number;
  tokensInContext: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export interface RequestLogEntry {
  requestId: string;
  question: string;
  k: number;
  retrieved: string[];
  outcome: "answered" | "refused";
  bestOverlap: number;
  usage: Usage;
  events: number;
  bytes: number;
  queueHighWater: number;
}

export interface RagServer {
  server: Server;
  log: RequestLogEntry[];
}

export interface RagServerOptions {
  /** Refusal floor on the best sentence's overlap score. */
  minOverlap?: number;
}

/** The prompt-shaped rendering of a doc that the token accounting prices. */
export function renderDoc(doc: Doc): string {
  return `# ${doc.title}\n${doc.text}`;
}

export function computeUsage(question: string, context: readonly Doc[], answer: string): Usage {
  const tokensInSystem = estimateTokens(SYSTEM_PROMPT);
  const tokensInQuestion = estimateTokens(question);
  let tokensInContext = 0;
  for (const doc of context) tokensInContext += estimateTokens(renderDoc(doc));
  const tokensIn = tokensInSystem + tokensInQuestion + tokensInContext;
  const tokensOut = estimateTokens(answer);
  return {
    tokensInSystem,
    tokensInQuestion,
    tokensInContext,
    tokensIn,
    tokensOut,
    costUsd: costUsd(tokensIn, tokensOut),
  };
}

function jsonError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}

interface ParsedAsk {
  question: string;
  k: number;
}

/** Validate the request body; returns an error string or the parsed ask. */
export function parseAskBody(body: string, maxK: number): ParsedAsk | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "body must be valid json";
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "body must be a json object";
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record["question"] !== "string") return 'field "question" must be a string';
  const question = record["question"].trim();
  if (question.length === 0) return 'field "question" must not be empty';
  const rawK = record["k"] ?? DEFAULT_K;
  if (!Number.isInteger(rawK) || (rawK as number) < 1 || (rawK as number) > maxK) {
    return `field "k" must be an integer in 1..${maxK}`;
  }
  return { question, k: rawK as number };
}

function sinkFor(res: ServerResponse): StreamSink {
  return {
    write: (chunk) => res.write(chunk),
    waitDrain: () => new Promise((resolve) => res.once("drain", resolve)),
  };
}

export function createRagServer(docs: readonly Doc[], options: RagServerOptions = {}): RagServer {
  const minOverlap = options.minOverlap ?? MIN_OVERLAP;
  const index = new DocIndex(docs);
  const log: RequestLogEntry[] = [];
  let requestCounter = 0;

  const server = createServer((req, res) => {
    if (req.url === "/healthz" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, docs: index.size, requestsServed: log.length }));
      return;
    }
    if (req.url !== "/ask") {
      jsonError(res, 404, "not found");
      return;
    }
    if (req.method !== "POST") {
      jsonError(res, 405, "use POST");
      return;
    }

    const chunks: Buffer[] = [];
    let bodyBytes = 0;
    let overflowed = false;
    req.on("data", (chunk: Buffer) => {
      bodyBytes += chunk.length;
      if (bodyBytes > MAX_BODY_BYTES) overflowed = true;
      else chunks.push(chunk);
    });
    req.on("end", () => {
      if (overflowed) {
        jsonError(res, 413, `body exceeds ${MAX_BODY_BYTES} bytes`);
        return;
      }
      const ask = parseAskBody(Buffer.concat(chunks).toString("utf-8"), Math.min(MAX_K, index.size));
      if (typeof ask === "string") {
        jsonError(res, 400, ask);
        return;
      }
      if (ask.question.length > MAX_QUESTION_CHARS) {
        jsonError(res, 413, `question exceeds ${MAX_QUESTION_CHARS} characters`);
        return;
      }
      void serveAsk(ask, res);
    });
  });

  async function serveAsk(ask: ParsedAsk, res: ServerResponse): Promise<void> {
    const requestId = `r${String(++requestCounter).padStart(4, "0")}`;
    const retrieved = index.topK(ask.question, ask.k);
    const context = retrieved.map((r) => r.doc);
    const { answer, bestOverlap } = scoredAnswer(ask.question, context, minOverlap);
    const usage = computeUsage(ask.question, context, answer);
    const outcome = answer === REFUSAL ? "refused" : "answered";

    const events: WireEvent[] = [
      {
        event: "meta",
        data: JSON.stringify({
          requestId,
          k: ask.k,
          retrieved: retrieved.map((r) => ({ docId: r.doc.id, score: Number(r.score.toFixed(4)) })),
        }),
      },
      ...answerPieces(answer).map((piece) => ({ event: "token", data: JSON.stringify({ text: piece }) })),
      { event: "done", data: JSON.stringify({ outcome, bestOverlap, usage }) },
    ];

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const result = await streamEvents(events, sinkFor(res), QUEUE_CAPACITY);
    res.end();
    log.push({
      requestId,
      question: ask.question,
      k: ask.k,
      retrieved: retrieved.map((r) => r.doc.id),
      outcome,
      bestOverlap,
      usage,
      events: result.events,
      bytes: result.bytes,
      queueHighWater: result.queue.highWaterMark,
    });
  }

  return { server, log };
}
