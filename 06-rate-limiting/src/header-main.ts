/**
 * Header study entry point, three questions:
 *
 * 1. The 429 is one bit of feedback; RateLimit headers are a number. On the
 *    pacing study's budget-drop scenario, how much of AIMD's makespan tax
 *    over the oracle does a header-reading client recover, trusting the
 *    limit header vs recovering the rate from remaining-token deltas alone?
 *
 * 2. The informed client paces at 100% of the budget and inherits the
 *    zero-headroom fragility the pacing sweep found. A headroom sweep on the
 *    oracle and the header client prices the safety margin directly.
 *
 * 3. The remaining-only estimator's signal is asymmetric: an empty bucket
 *    is fully informative, a full one is censored. A budget-rise scenario
 *    (8 -> 20 req/s) measures what each controller does when capacity comes
 *    back.
 */

import { runPacingStudy, type PacerSpec, type PacingStudyResult } from "./pacing-study.js";
import type { HeaderPacerOptions } from "./header-pacer.js";
import type { RetryOptions } from "./retry.js";

const RETRY: RetryOptions = {
  policy: { kind: "full-jitter", baseMs: 100, capMs: 10_000 },
  maxRetries: 8,
  respectRetryAfter: false,
};

const SERVER_RATE = 20;
const SERVER_BURST = 20;
const DROP_AT_MS = 30_000;
const DROPPED_RATE = 8;

const DROP_BASE = {
  clients: 20,
  requestsPerClient: 50,
  serverRatePerSec: SERVER_RATE,
  serverBurst: SERVER_BURST,
  rateSchedule: [{ atMs: DROP_AT_MS, ratePerSec: DROPPED_RATE }],
  phaseBoundaryMs: DROP_AT_MS,
  faultRate: 0.02,
  latencyMsMin: 20,
  latencyMsMax: 60,
  advertiseRetryAfter: true,
  advertiseRateHeaders: true,
  retry: RETRY,
  seed: 42,
};

const RISE_AT_MS = 30_000;
const RISE_BASE = {
  ...DROP_BASE,
  serverRatePerSec: DROPPED_RATE,
  rateSchedule: [{ atMs: RISE_AT_MS, ratePerSec: SERVER_RATE }],
  phaseBoundaryMs: RISE_AT_MS,
};

function headerOpts(mode: HeaderPacerOptions["mode"], headroom: number): HeaderPacerOptions {
  return {
    mode,
    initialRatePerSec: 4,
    minRatePerSec: 1,
    maxRatePerSec: 40,
    headroom,
    burst: 5,
    minWindowMs: 500,
    ewmaAlpha: 0.5,
    probeIncreasePerSec: 2,
    capSlackTokens: 3,
  };
}

const AIMD_SPEC: PacerSpec = {
  kind: "aimd",
  opts: {
    initialRatePerSec: 4,
    minRatePerSec: 1,
    maxRatePerSec: 40,
    increasePerSec: 2,
    decreaseFactor: 0.6,
    holdOffMs: 1000,
    burst: 5,
  },
};

function fmt(value: number, digits = 0): string {
  return Number.isNaN(value) ? "-" : value.toFixed(digits);
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function printTable(results: PacingStudyResult[]): void {
  const header = [
    "strategy".padEnd(14),
    "success".padStart(8),
    "attempts".padStart(9),
    "att/ok".padStart(7),
    "429 ph1".padStart(8),
    "429 ph2".padStart(8),
    "ok/s ph1".padStart(9),
    "ok/s ph2".padStart(9),
    "makespan".padStart(9),
  ].join("  ");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const r of results) {
    console.log(
      [
        r.name.padEnd(14),
        pct(r.succeeded / r.requests).padStart(8),
        fmt(r.totalAttempts).padStart(9),
        fmt(r.attemptsPerSuccess, 2).padStart(7),
        fmt(r.phase1Count429!).padStart(8),
        fmt(r.phase2Count429!).padStart(8),
        fmt(r.phase1OkPerSec!, 2).padStart(9),
        fmt(r.phase2OkPerSec!, 2).padStart(9),
        `${fmt(r.makespanMs / 1000, 2)}s`.padStart(9),
      ].join("  "),
    );
  }
}

function printTrace(label: string, r: PacingStudyResult): void {
  console.log(
    `${label} rate trace (sampled every 5s): ` +
      r.rateTrace!.map((p) => `t=${(p.atMs / 1000).toFixed(0)}s ${p.ratePerSec.toFixed(1)}`).join("  "),
  );
}

function tax(r: PacingStudyResult, oracle: PacingStudyResult): string {
  return pct(r.makespanMs / oracle.makespanMs - 1);
}

async function gapRecovery(): Promise<void> {
  console.log(
    `part 1, the budget drops mid-run, now with headers: ${DROP_BASE.clients} clients x ` +
      `${DROP_BASE.requestsPerClient} requests, server ${SERVER_RATE} req/s until t=${DROP_AT_MS / 1000}s ` +
      `then ${DROPPED_RATE} req/s, seed ${DROP_BASE.seed}`,
  );
  console.log(
    `every response carries RateLimit headers (limit + remaining); retry full jitter base 100ms ` +
      `cap 10000ms max 8, Retry-After ignored; header clients start blind at 4 req/s like aimd\n`,
  );

  const specs: Array<[string, PacerSpec]> = [
    ["unpaced", { kind: "none" }],
    ["oracle", { kind: "oracle", burst: SERVER_BURST }],
    ["aimd", AIMD_SPEC],
    ["hdr-limit", { kind: "header", opts: headerOpts("trust-limit", 1.0) }],
    ["hdr-remaining", { kind: "header", opts: headerOpts("remaining-only", 1.0) }],
    ["hdr-remain-95", { kind: "header", opts: headerOpts("remaining-only", 0.95) }],
  ];
  const results: PacingStudyResult[] = [];
  for (const [name, spec] of specs) {
    results.push(await runPacingStudy(name, spec, { ...DROP_BASE, traceIntervalMs: 5000 }));
  }
  printTable(results);

  const byName = new Map(results.map((r) => [r.name, r]));
  const oracle = byName.get("oracle")!;
  const aimd = byName.get("aimd")!;
  const hdrLimit = byName.get("hdr-limit")!;
  const hdrRemaining = byName.get("hdr-remaining")!;
  const hdrRemain95 = byName.get("hdr-remain-95")!;

  console.log("");
  printTrace("hdr-remaining", hdrRemaining);
  console.log(
    `hdr-remaining learning mix: ${hdrRemaining.headerObservations} header observations -> ` +
      `${hdrRemaining.estimateUpdates} estimate windows, ${hdrRemaining.probeUpdates} censored/probe windows`,
  );

  console.log("\npart 1 findings:");
  console.log(
    `- aimd pays a ${tax(aimd, oracle)} makespan tax over the oracle (${fmt(aimd.makespanMs / 1000, 2)}s vs ` +
      `${fmt(oracle.makespanMs / 1000, 2)}s) plus ${aimd.count429} 429s of sawtooth probing; trusting the ` +
      `limit header cuts the tax to ${tax(hdrLimit, oracle)} (${fmt(hdrLimit.makespanMs / 1000, 2)}s) and the ` +
      `429s to ${hdrLimit.count429}: one response converts the unknown-budget problem into the oracle's`,
  );
  console.log(
    `- the remaining-only estimator at full throttle recovers almost none of the tax ` +
      `(${tax(hdrRemaining, oracle)}, ${fmt(hdrRemaining.makespanMs / 1000, 2)}s) and takes ` +
      `${hdrRemaining.count429} 429s, more than aimd's ${aimd.count429}: the makespan cost is the blind ` +
      `4 req/s start both share (each probes upward at 2 req/s per second), and pacing at exactly the ` +
      `recovered budget grazes the limit continuously once the drop empties the bucket ` +
      `(${hdrRemaining.phase2Count429} of its 429s land in phase 2)`,
  );
  console.log(
    `- the production shape is estimator plus margin: at 95% headroom hdr-remain-95 takes ` +
      `${hdrRemain95.count429} 429s, the entire sawtooth skipped, at ${fmt(hdrRemain95.makespanMs / 1000, 2)}s ` +
      `(${pct(hdrRemain95.makespanMs / aimd.makespanMs - 1)} over aimd). whether that trade wins depends on ` +
      `what a 429 costs upstream of you`,
  );
}

async function headroomSweep(): Promise<void> {
  console.log(
    `\npart 2, pricing the safety margin: same drop scenario, oracle and hdr-limit paced at ` +
      `85% to 100% of the (known or advertised) budget\n`,
  );

  const headrooms = [0.85, 0.9, 0.95, 1.0];
  const results: PacingStudyResult[] = [];
  for (const h of headrooms) {
    results.push(
      await runPacingStudy(`oracle-${Math.round(h * 100)}`, { kind: "oracle", burst: SERVER_BURST, headroom: h }, DROP_BASE),
    );
  }
  // Attribution control: the informed rate at 100%, but a pacing bucket that
  // releases the t=0 herd at burst 5 instead of all 20 at once.
  results.push(await runPacingStudy("oracle-100-b5", { kind: "oracle", burst: 5, headroom: 1 }, DROP_BASE));
  for (const h of headrooms) {
    results.push(
      await runPacingStudy(`hdr-limit-${Math.round(h * 100)}`, { kind: "header", opts: headerOpts("trust-limit", h) }, DROP_BASE),
    );
  }

  const header = [
    "strategy".padEnd(14),
    "headroom".padStart(8),
    "success".padStart(8),
    "failed".padStart(7),
    "429s".padStart(6),
    "att/ok".padStart(7),
    "makespan".padStart(9),
  ].join("  ");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const r of results) {
    const h = r.name.match(/-(\d+)/)![1];
    console.log(
      [
        r.name.padEnd(14),
        `${h}%`.padStart(8),
        pct(r.succeeded / r.requests).padStart(8),
        fmt(r.failed).padStart(7),
        fmt(r.count429).padStart(6),
        fmt(r.attemptsPerSuccess, 2).padStart(7),
        `${fmt(r.makespanMs / 1000, 2)}s`.padStart(9),
      ].join("  "),
    );
  }

  const byName = new Map(results.map((r) => [r.name, r]));
  const o100 = byName.get("oracle-100")!;
  const o100b5 = byName.get("oracle-100-b5")!;
  const o95 = byName.get("oracle-95")!;
  const o90 = byName.get("oracle-90")!;
  console.log("\npart 2 findings:");
  console.log(
    `- the 100% oracle's ${o100.failed} failures are not about the average rate: the identical informed rate ` +
      `behind a burst-5 pacing bucket (oracle-100-b5) fails ${o100b5.failed} with ${o100b5.count429} 429s. ` +
      `the knife edge lives in the 20-wide t=0 burst the burst-20 bucket admits at once, which lands the ` +
      `whole herd before the first fault retry has anywhere to go`,
  );
  console.log(
    `- two fixes, priced: 5% of margin (oracle-95: ${o95.failed} failed, ${o95.count429} 429s) costs ` +
      `${fmt((o95.makespanMs - o100.makespanMs) / 1000, 2)}s of makespan; shaping the burst (oracle-100-b5) ` +
      `costs ${fmt((o100b5.makespanMs - o100.makespanMs) / 1000, 2)}s. past the fix, margin prices as pure ` +
      `throughput: 95% -> 90% adds ${fmt((o90.makespanMs - o95.makespanMs) / 1000, 2)}s and buys nothing ` +
      `measurable here`,
  );
}

async function riseScenario(): Promise<void> {
  console.log(
    `\npart 3, the budget rises mid-run: server ${DROPPED_RATE} req/s until t=${RISE_AT_MS / 1000}s then ` +
      `${SERVER_RATE} req/s, same clients/retries/seed\n`,
  );

  const specs: Array<[string, PacerSpec]> = [
    ["oracle", { kind: "oracle", burst: SERVER_BURST }],
    ["aimd", AIMD_SPEC],
    ["hdr-limit", { kind: "header", opts: headerOpts("trust-limit", 1.0) }],
    ["hdr-remaining", { kind: "header", opts: headerOpts("remaining-only", 1.0) }],
  ];
  const results: PacingStudyResult[] = [];
  for (const [name, spec] of specs) {
    results.push(await runPacingStudy(name, spec, { ...RISE_BASE, traceIntervalMs: 5000 }));
  }
  printTable(results);

  const byName = new Map(results.map((r) => [r.name, r]));
  const oracle = byName.get("oracle")!;
  const aimd = byName.get("aimd")!;
  const hdrLimit = byName.get("hdr-limit")!;
  const hdrRemaining = byName.get("hdr-remaining")!;

  console.log("");
  printTrace("hdr-remaining", hdrRemaining);
  printTrace("aimd", aimd);
  console.log(
    `hdr-remaining learning mix: ${hdrRemaining.estimateUpdates} estimate windows, ` +
      `${hdrRemaining.probeUpdates} censored/probe windows`,
  );

  console.log("\npart 3 findings:");
  console.log(
    `- a capacity raise is silent: no 429 announces it, so the 429-driven and remaining-driven controllers ` +
      `alike must probe for it. hdr-limit reads it off the next response and finishes in ` +
      `${fmt(hdrLimit.makespanMs / 1000, 2)}s; aimd (${fmt(aimd.makespanMs / 1000, 2)}s) and hdr-remaining ` +
      `(${fmt(hdrRemaining.makespanMs / 1000, 2)}s) climb at their shared 2 req/s-per-second probe rate, ` +
      `reaching the new budget about 6 seconds late, which this backlog absorbs into under a second of ` +
      `extra makespan`,
  );
  console.log(
    `- the perfectly informed oracle is the slowest row (${fmt(oracle.makespanMs / 1000, 2)}s, ` +
      `${oracle.failed} failed): pacing at 100% of a known budget leaves fault retries nowhere to land, and ` +
      `the retry-burnout tail stretches its makespan past every adaptive client whose slack is accidental ` +
      `headroom`,
  );
  console.log(
    `- phase 2 is the estimator's censored regime: the bucket rides its cap, refill is invisible, and its ` +
      `${hdrRemaining.probeUpdates} probe windows carry only the full-bucket bit (capacity >= my send rate). ` +
      `the cost gap is in what probing spends: aimd buys its ceiling with 429s (${aimd.count429} of them, ` +
      `${aimd.cuts} cuts), the estimator re-locks from refill arithmetic the moment the bucket drains and ` +
      `takes ${hdrRemaining.count429}`,
  );
}

await gapRecovery();
await headroomSweep();
await riseScenario();
