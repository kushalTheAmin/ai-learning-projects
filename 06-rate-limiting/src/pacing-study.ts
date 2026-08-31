/**
 * Pacing study runner: one pacer variant against a fresh server, same seeds.
 * Unlike the herd experiment, the server's admission rate can change mid-run
 * on a schedule, and results can be split at a phase boundary so a strategy's
 * behavior before and after a capacity change is visible separately. Clients
 * work through their requests sequentially starting at t=0; first attempts go
 * through the pacer, retries re-enter unpaced (the base study's contract), and
 * under AIMD every 429, paced or not, feeds the rate controller.
 */

import { AimdPacer, type AimdOptions } from "./adaptive.js";
import { VirtualClock } from "./clock.js";
import { PacingLimiter } from "./limiter.js";
import { requestWithRetry, type RequestOutcome, type RetryOptions } from "./retry.js";
import { SimulatedApi } from "./server.js";
import { createRng } from "../../05-token-streaming/src/rng.js";

export type PacerSpec =
  | { kind: "none" }
  | { kind: "fixed"; ratePerSec: number; burst: number }
  /** Follows the server's rate schedule exactly: the perfectly informed client. */
  | { kind: "oracle"; burst: number }
  | { kind: "aimd"; opts: AimdOptions };

export interface PacingStudyOptions {
  clients: number;
  requestsPerClient: number;
  serverRatePerSec: number;
  serverBurst: number;
  /** Admission-rate changes applied at exact virtual instants, ascending atMs. */
  rateSchedule?: Array<{ atMs: number; ratePerSec: number }>;
  faultRate: number;
  latencyMsMin: number;
  latencyMsMax: number;
  advertiseRetryAfter: boolean;
  retry: RetryOptions;
  seed: number;
  /** Split per-phase metrics at this instant; omit for single-phase runs. */
  phaseBoundaryMs?: number;
  /** Sample the AIMD rate every this many ms; omit to skip the trace. */
  traceIntervalMs?: number;
}

export interface PacingStudyResult {
  name: string;
  requests: number;
  succeeded: number;
  failed: number;
  totalAttempts: number;
  attemptsPerSuccess: number;
  count429: number;
  count503: number;
  makespanMs: number;
  /** Successes per second of makespan. */
  okPerSec: number;
  /** Filled only when phaseBoundaryMs is set. */
  phase1OkPerSec?: number;
  phase2OkPerSec?: number;
  phase1Count429?: number;
  phase2Count429?: number;
  /** AIMD only: congestion cuts taken and the sampled rate over time. */
  cuts?: number;
  rateTrace?: Array<{ atMs: number; ratePerSec: number }>;
}

export async function runPacingStudy(
  name: string,
  pacer: PacerSpec,
  opts: PacingStudyOptions,
): Promise<PacingStudyResult> {
  if (!Number.isInteger(opts.clients) || opts.clients < 0) {
    throw new Error(`clients must be a non-negative integer, got ${opts.clients}`);
  }
  if (!Number.isInteger(opts.requestsPerClient) || opts.requestsPerClient < 0) {
    throw new Error(`requestsPerClient must be a non-negative integer, got ${opts.requestsPerClient}`);
  }
  const schedule = opts.rateSchedule ?? [];
  for (let i = 0; i < schedule.length; i++) {
    const entry = schedule[i]!;
    if (!Number.isFinite(entry.atMs) || entry.atMs < 0) {
      throw new Error(`rateSchedule atMs must be a finite non-negative number, got ${entry.atMs}`);
    }
    if (i > 0 && entry.atMs <= schedule[i - 1]!.atMs) {
      throw new Error("rateSchedule must be strictly ascending in atMs");
    }
  }

  const clock = new VirtualClock();
  const api = new SimulatedApi(clock, createRng(opts.seed), {
    ratePerSec: opts.serverRatePerSec,
    burst: opts.serverBurst,
    faultRate: opts.faultRate,
    latencyMsMin: opts.latencyMsMin,
    latencyMsMax: opts.latencyMsMax,
    advertiseRetryAfter: opts.advertiseRetryAfter,
  });

  const fixedLimiter =
    pacer.kind === "fixed"
      ? new PacingLimiter(pacer.ratePerSec, pacer.burst, clock)
      : pacer.kind === "oracle"
        ? new PacingLimiter(opts.serverRatePerSec, pacer.burst, clock)
        : undefined;
  const aimd = pacer.kind === "aimd" ? new AimdPacer(pacer.opts, clock) : undefined;

  // Rate changes fire at exact virtual instants, not at the next request.
  for (const entry of schedule) {
    void clock.sleep(entry.atMs).then(() => {
      api.setRate(entry.ratePerSec);
      if (pacer.kind === "oracle") fixedLimiter!.setRate(entry.ratePerSec);
    });
  }

  const rateTrace: Array<{ atMs: number; ratePerSec: number }> = [];
  let running = true;
  if (aimd && opts.traceIntervalMs !== undefined) {
    const interval = opts.traceIntervalMs;
    if (!Number.isFinite(interval) || interval <= 0) {
      throw new Error(`traceIntervalMs must be positive, got ${interval}`);
    }
    void (async () => {
      while (running) {
        rateTrace.push({ atMs: clock.now(), ratePerSec: aimd.currentRatePerSec() });
        await clock.sleep(interval);
      }
    })();
  }

  const send = async (attempt: number) => {
    const res = await api.request(attempt > 1);
    if (res.status === 429) aimd?.on429();
    return res;
  };

  const outcomes: RequestOutcome[] = [];
  const runClient = async (clientIndex: number): Promise<void> => {
    const clientRng = createRng(opts.seed + 1 + clientIndex);
    for (let i = 0; i < opts.requestsPerClient; i++) {
      if (fixedLimiter) await fixedLimiter.acquire();
      if (aimd) await aimd.acquire();
      outcomes.push(await requestWithRetry(send, clock, clientRng, opts.retry));
    }
  };

  const allClients = Promise.all(
    Array.from({ length: opts.clients }, (_, i) => runClient(i)),
  ).finally(() => {
    running = false;
  });
  await clock.runUntil(allClients);

  const succeeded = outcomes.filter((o) => o.ok);
  const makespanMs = outcomes.length === 0 ? 0 : Math.max(...outcomes.map((o) => o.endMs));
  const result: PacingStudyResult = {
    name,
    requests: outcomes.length,
    succeeded: succeeded.length,
    failed: outcomes.length - succeeded.length,
    totalAttempts: api.totalAttempts(),
    attemptsPerSuccess: succeeded.length === 0 ? Number.NaN : api.totalAttempts() / succeeded.length,
    count429: api.count429,
    count503: api.count503,
    makespanMs,
    okPerSec: makespanMs === 0 ? Number.NaN : succeeded.length / (makespanMs / 1000),
  };
  if (opts.phaseBoundaryMs !== undefined) {
    const boundary = opts.phaseBoundaryMs;
    const phase1Ok = succeeded.filter((o) => o.endMs < boundary).length;
    const phase2Ok = succeeded.length - phase1Ok;
    const phase1Span = Math.min(boundary, makespanMs);
    const phase2Span = Math.max(0, makespanMs - boundary);
    result.phase1OkPerSec = phase1Span === 0 ? Number.NaN : phase1Ok / (phase1Span / 1000);
    result.phase2OkPerSec = phase2Span === 0 ? Number.NaN : phase2Ok / (phase2Span / 1000);
    result.phase1Count429 = api.rejection429Ms.filter((t) => t < boundary).length;
    result.phase2Count429 = api.count429 - result.phase1Count429;
  }
  if (aimd) {
    result.cuts = aimd.cuts;
    if (opts.traceIntervalMs !== undefined) result.rateTrace = rateTrace;
  }
  return result;
}
