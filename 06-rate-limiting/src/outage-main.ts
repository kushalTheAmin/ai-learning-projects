/**
 * Entry point for the outage studies:
 *   1. server-jittered Retry-After hints on the steady thundering herd
 *   2. outage recovery: which retry schedules outlive a hard-down window
 *   3. the dead service: what retrying costs when nobody can ever succeed
 * Same virtual clock, same seeds, fresh server per run.
 */

import { runScenario, type ScenarioOptions, type StrategySpec } from "./experiment.js";
import {
  runOutageScenario,
  type OutageResult,
  type OutageScenarioOptions,
  type OutageStrategySpec,
} from "./outage.js";
import { cappedExponential } from "./backoff.js";
import type { RetryOptions } from "./retry.js";

const BASE_MS = 100;
const CAP_MS = 10_000;
const MAX_RETRIES = 8;
const SEED = 42;

function fmt(value: number, digits = 0): string {
  return Number.isNaN(value) ? "-" : value.toFixed(digits);
}

function fmtSec(valueMs: number, digits = 2): string {
  return Number.isNaN(valueMs) ? "-" : `${(valueMs / 1000).toFixed(digits)}s`;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function retryOpts(policy: RetryOptions["policy"], respectRetryAfter: boolean): RetryOptions {
  return { policy, maxRetries: MAX_RETRIES, respectRetryAfter };
}

/** Worst-case total backoff a client can wait before its final attempt. */
function maxCumulativeBackoffMs(): number {
  let total = 0;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    total += cappedExponential(BASE_MS, CAP_MS, attempt);
  }
  return total;
}

async function studyHintJitter(): Promise<void> {
  const herd: ScenarioOptions = {
    clients: 40,
    requestsPerClient: 5,
    serverRatePerSec: 20,
    serverBurst: 20,
    faultRate: 0.02,
    latencyMsMin: 20,
    latencyMsMax: 60,
    advertiseRetryAfter: true,
    seed: SEED,
    peakWindowMs: 100,
  };
  const strategy: StrategySpec = {
    name: "full-jitter+retry-after",
    retry: retryOpts({ kind: "full-jitter", baseMs: BASE_MS, capMs: CAP_MS }, true),
  };

  console.log("study 1: server-jittered Retry-After hints on the steady herd");
  console.log(
    `same scenario and strategy as the main table's full-jitter+retry-after row ` +
      `(40 clients x 5 requests, 20 req/s, seed ${SEED}); only the server's hint changes: ` +
      `exact time-to-next-token plus uniform [0, jitter] ms\n`,
  );
  const header = [
    "hint jitter".padEnd(12),
    "success".padStart(8),
    "att/ok".padStart(7),
    "429s".padStart(6),
    "makespan".padStart(9),
    "p50 ok".padStart(7),
    "peak/100ms".padStart(11),
    "collide".padStart(8),
  ].join("  ");
  console.log(header);
  console.log("-".repeat(header.length));
  const rows = [];
  for (const hintJitterMs of [0, 50, 100, 200, 500]) {
    const r = await runScenario(strategy, { ...herd, hintJitterMs });
    rows.push({ hintJitterMs, r });
    console.log(
      [
        (hintJitterMs === 0 ? "exact" : `${hintJitterMs}ms`).padEnd(12),
        pct(r.succeeded / r.requests).padStart(8),
        fmt(r.attemptsPerSuccess, 2).padStart(7),
        fmt(r.count429).padStart(6),
        fmtSec(r.makespanMs).padStart(9),
        `${fmt(r.p50LatencyMs)}ms`.padStart(7),
        fmt(r.peakArrivalsPerWindow).padStart(11),
        fmt(r.maxSimultaneousRetries).padStart(8),
      ].join("  "),
    );
  }

  // One seed's makespan is dominated by whichever request draws a transient
  // 503 late (a single backoff there can reach the 10s cap), so the width
  // comparison gets a seed sweep before any makespan claim.
  const seeds = [42, 43, 44, 45, 46];
  console.log(`\nexact vs 200ms hint jitter across seeds ${seeds[0]}-${seeds[seeds.length - 1]}:`);
  const sweepHeader = [
    "seed".padEnd(6),
    "makespan exact".padStart(15),
    "collide".padStart(8),
    "makespan 200ms".padStart(15),
    "collide".padStart(8),
  ].join("  ");
  console.log(sweepHeader);
  console.log("-".repeat(sweepHeader.length));
  let sumExact = 0;
  let sumJittered = 0;
  let maxCollideExact = 0;
  let maxCollideJittered = 0;
  const exactMakespans: number[] = [];
  for (const seed of seeds) {
    const exact = await runScenario(strategy, { ...herd, seed, hintJitterMs: 0 });
    const jittered = await runScenario(strategy, { ...herd, seed, hintJitterMs: 200 });
    exactMakespans.push(exact.makespanMs);
    sumExact += exact.makespanMs;
    sumJittered += jittered.makespanMs;
    maxCollideExact = Math.max(maxCollideExact, exact.maxSimultaneousRetries);
    maxCollideJittered = Math.max(maxCollideJittered, jittered.maxSimultaneousRetries);
    console.log(
      [
        String(seed).padEnd(6),
        fmtSec(exact.makespanMs).padStart(15),
        fmt(exact.maxSimultaneousRetries).padStart(8),
        fmtSec(jittered.makespanMs).padStart(15),
        fmt(jittered.maxSimultaneousRetries).padStart(8),
      ].join("  "),
    );
  }
  const meanExact = sumExact / seeds.length;
  const meanJittered = sumJittered / seeds.length;
  console.log(
    [
      "mean".padEnd(6),
      fmtSec(meanExact).padStart(15),
      fmt(maxCollideExact).padStart(8),
      fmtSec(meanJittered).padStart(15),
      fmt(maxCollideJittered).padStart(8),
    ].join("  ") + "   (collide column shows the max)",
  );
  console.log("\nfindings:");
  console.log(
    `- the jittered hint kills the re-synchronization at every width: worst collision across ` +
      `5 seeds is ${fmt(maxCollideJittered)} vs ${fmt(maxCollideExact)} with exact hints`,
  );
  console.log(
    `- and the makespan win survives: mean ${fmtSec(meanJittered)} jittered vs ` +
      `${fmtSec(meanExact)} exact, a ${fmtSec(Math.abs(meanJittered - meanExact))} difference ` +
      `inside a per-seed spread of ${fmtSec(Math.min(...exactMakespans))} to ` +
      `${fmtSec(Math.max(...exactMakespans))} for exact hints alone. the single-seed table above ` +
      `is the cautionary tale: seed ${SEED}'s 9.47s exact makespan (the number the main README ` +
      `calls closest to ideal) is the best of its 5 seeds, not the typical, because the makespan ` +
      `tail belongs to whichever request draws a transient 503 late and backs off toward the 10s cap`,
  );
}

interface RecoveryRow {
  name: string;
  retry: RetryOptions;
  hintJitterMs: number;
}

const RECOVERY_ROWS: RecoveryRow[] = [
  { name: "fixed-100ms", retry: retryOpts({ kind: "fixed", delayMs: BASE_MS }, false), hintJitterMs: 0 },
  { name: "exp-no-jitter", retry: retryOpts({ kind: "exponential", baseMs: BASE_MS, capMs: CAP_MS }, false), hintJitterMs: 0 },
  { name: "exp-full-jitter", retry: retryOpts({ kind: "full-jitter", baseMs: BASE_MS, capMs: CAP_MS }, false), hintJitterMs: 0 },
  { name: "exp-equal-jitter", retry: retryOpts({ kind: "equal-jitter", baseMs: BASE_MS, capMs: CAP_MS }, false), hintJitterMs: 0 },
  { name: "retry-after-exact", retry: retryOpts({ kind: "full-jitter", baseMs: BASE_MS, capMs: CAP_MS }, true), hintJitterMs: 0 },
  { name: "retry-after-jittered", retry: retryOpts({ kind: "full-jitter", baseMs: BASE_MS, capMs: CAP_MS }, true), hintJitterMs: 1000 },
];

function recoveryOpts(outageMs: number, hintJitterMs: number): OutageScenarioOptions {
  return {
    clients: 40,
    requestsPerClient: 1,
    serverRatePerSec: 20,
    serverBurst: 20,
    latencyMsMin: 20,
    latencyMsMax: 60,
    outageMs,
    advertiseOutageRetryAfter: true,
    hintJitterMs,
    seed: SEED,
  };
}

async function studyOutageRecovery(): Promise<void> {
  const budgetMs = maxCumulativeBackoffMs();
  console.log("\nstudy 2: outage recovery");
  console.log(
    `40 clients x 1 request at t=0, server hard-down over [0, outage) then healthy at ` +
      `20 req/s burst 20. outage 503s are instant, cost no admission tokens, and advertise ` +
      `time-to-recovery; only the retry-after rows listen. retry budget: base ${BASE_MS}ms, ` +
      `cap ${CAP_MS / 1000}s, max ${MAX_RETRIES} retries = ${(budgetMs / 1000).toFixed(1)}s ` +
      `worst-case total backoff, so no guessing schedule can outlive a ` +
      `${(budgetMs / 1000).toFixed(1)}s+ outage\n`,
  );

  const outages = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000];
  const gridHeader = [
    "success by outage".padEnd(21),
    ...outages.map((o) => `${o / 1000}s`.padStart(7)),
  ].join("  ");
  console.log(gridHeader);
  console.log("-".repeat(gridHeader.length));
  const grid = new Map<string, OutageResult>();
  for (const row of RECOVERY_ROWS) {
    const cells: string[] = [];
    for (const outageMs of outages) {
      const r = await runOutageScenario(
        { name: row.name, retry: row.retry },
        recoveryOpts(outageMs, row.hintJitterMs),
      );
      grid.set(`${row.name}@${outageMs}`, r);
      cells.push(pct(r.succeeded / r.requests).padStart(7));
    }
    console.log([row.name.padEnd(21), ...cells].join("  "));
  }
  const detail = new Map<string, OutageResult>(
    RECOVERY_ROWS.map((row) => [row.name, grid.get(`${row.name}@${10_000}`)!]),
  );

  console.log(`\ndetail at the 10s outage:`);
  const header = [
    "strategy".padEnd(21),
    "success".padStart(8),
    "attempts".padStart(9),
    "wasted".padStart(7),
    "429s".padStart(5),
    "rec peak".padStart(9),
    "makespan".padStart(9),
    "drain".padStart(7),
    "give-up p50".padStart(12),
    "collide".padStart(8),
  ].join("  ");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const row of RECOVERY_ROWS) {
    const r = detail.get(row.name)!;
    console.log(
      [
        r.name.padEnd(21),
        pct(r.succeeded / r.requests).padStart(8),
        fmt(r.totalAttempts).padStart(9),
        fmt(r.attemptsDuringOutage).padStart(7),
        fmt(r.count429).padStart(5),
        fmt(r.recoveryPeakPer100ms).padStart(9),
        fmtSec(r.makespanMs).padStart(9),
        fmtSec(r.drainMs).padStart(7),
        fmtSec(r.giveUpP50Ms, 1).padStart(12),
        fmt(r.maxSimultaneousRetries).padStart(8),
      ].join("  "),
    );
  }
  console.log(
    `\n'wasted' = attempts that landed while the service was down. 'rec peak' = peak ` +
      `arrivals/100ms from the recovery instant on. 'drain' = makespan minus outage.`,
  );

  const noJitter = detail.get("exp-no-jitter")!;
  const fullJitter = detail.get("exp-full-jitter")!;
  const exact = detail.get("retry-after-exact")!;
  const jittered = detail.get("retry-after-jittered")!;
  console.log("\nfindings:");
  console.log(
    `- at a 10s outage, jitter is the liability: exp-no-jitter lands ${pct(noJitter.succeeded / noJitter.requests)} ` +
      `because its deterministic schedule cannot spend the budget early, while full jitter's ` +
      `short draws burn retries during the outage and only ${pct(fullJitter.succeeded / fullJitter.requests)} survive`,
  );
  console.log(
    `- the survivors of a deterministic schedule arrive as one wall: exp-no-jitter's recovery ` +
      `peak is ${fmt(noJitter.recoveryPeakPer100ms)} arrivals/100ms with ${fmt(noJitter.maxSimultaneousRetries)}-wide collisions`,
  );
  console.log(
    `- an exact recovery hint re-creates the herd it prevented: retry-after-exact sends its ` +
      `${fmt(exact.attemptsAfterRecovery)} post-recovery attempts into a ${fmt(exact.recoveryPeakPer100ms)}/100ms spike ` +
      `(${fmt(exact.count429)} 429s), the jittered hint spreads them to ${fmt(jittered.recoveryPeakPer100ms)}/100ms ` +
      `(${fmt(jittered.count429)} 429s) and still drains in ${fmtSec(jittered.drainMs)} vs ${fmtSec(exact.drainMs)}`,
  );
  const noJitter20 = grid.get(`exp-no-jitter@${20_000}`)!;
  console.log(
    `- surviving the outage is not surviving the recovery: at 20s, exp-no-jitter's whole herd ` +
      `still has one attempt left and spends it in a single ${fmt(noJitter20.maxSimultaneousRetries)}-wide ` +
      `wall at 22.7s, the burst admits ${fmt(noJitter20.succeeded)} and the other ` +
      `${fmt(noJitter20.failed)} burn their final attempt on a 429`,
  );
}

async function studyDeadService(): Promise<void> {
  console.log("\nstudy 3: the dead service");
  console.log(
    `40 clients x 3 sequential requests against a server that never recovers (every attempt ` +
      `an instant 503, no hints). nobody can succeed; the numbers are the cost of finding ` +
      `that out with a per-request retry budget and no memory between requests\n`,
  );
  const rows: OutageStrategySpec[] = [
    { name: "no-retry", retry: { policy: { kind: "none" }, maxRetries: 0, respectRetryAfter: false } },
    { name: "fixed-100ms", retry: retryOpts({ kind: "fixed", delayMs: BASE_MS }, false) },
    { name: "exp-no-jitter", retry: retryOpts({ kind: "exponential", baseMs: BASE_MS, capMs: CAP_MS }, false) },
    { name: "exp-full-jitter", retry: retryOpts({ kind: "full-jitter", baseMs: BASE_MS, capMs: CAP_MS }, false) },
  ];
  const opts: OutageScenarioOptions = {
    clients: 40,
    requestsPerClient: 3,
    serverRatePerSec: 20,
    serverBurst: 20,
    latencyMsMin: 20,
    latencyMsMax: 60,
    outageMs: Number.POSITIVE_INFINITY,
    advertiseOutageRetryAfter: false,
    hintJitterMs: 0,
    seed: SEED,
  };
  const header = [
    "strategy".padEnd(17),
    "attempts".padStart(9),
    "att/req".padStart(8),
    "makespan".padStart(9),
    "peak att/s".padStart(11),
    "give-up p50".padStart(12),
    "give-up p99".padStart(12),
  ].join("  ");
  console.log(header);
  console.log("-".repeat(header.length));
  const results: OutageResult[] = [];
  for (const row of rows) {
    const r = await runOutageScenario(row, opts);
    results.push(r);
    console.log(
      [
        r.name.padEnd(17),
        fmt(r.totalAttempts).padStart(9),
        fmt(r.totalAttempts / r.requests, 1).padStart(8),
        fmtSec(r.makespanMs).padStart(9),
        fmt(r.peakAttemptsPerSec).padStart(11),
        fmtSec(r.giveUpP50Ms).padStart(12),
        fmtSec(r.giveUpP99Ms).padStart(12),
      ].join("  "),
    );
  }
  const fixed = results.find((r) => r.name === "fixed-100ms")!;
  const noJitter = results.find((r) => r.name === "exp-no-jitter")!;
  const fullJitter = results.find((r) => r.name === "exp-full-jitter")!;
  console.log("\nfindings:");
  console.log(
    `- the retry budget, not the backoff policy, sets total waste: every retrying strategy ` +
      `burns exactly ${fmt(fixed.totalAttempts / fixed.requests, 0)} attempts per request ` +
      `(${fmt(fixed.totalAttempts)} total); backoff only chooses the shape, fixed-100ms hammers ` +
      `${fmt(fixed.peakAttemptsPerSec)} attempts/s for ${fmtSec(fixed.makespanMs)} while ` +
      `exp-no-jitter drips ${fmt(noJitter.peakAttemptsPerSec)}/s for ${fmtSec(noJitter.makespanMs)}`,
  );
  console.log(
    `- a caller waiting on a dead dependency hangs ${fmtSec(noJitter.giveUpP50Ms)} ` +
      `(no jitter) or ${fmtSec(fullJitter.giveUpP50Ms)} p50 (full jitter) before hearing "no", ` +
      `then the next request starts the same climb from ${BASE_MS}ms again: without a circuit ` +
      `breaker, sequential requests never learn`,
  );
}

async function main(): Promise<void> {
  await studyHintJitter();
  await studyOutageRecovery();
  await studyDeadService();
}

await main();
