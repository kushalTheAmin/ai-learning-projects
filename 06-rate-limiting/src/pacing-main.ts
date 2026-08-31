/**
 * Pacing study entry point, two questions:
 *
 * 1. Rate sweep: client-side pacing swept from 80% to 120% of a 20 req/s
 *    server budget, steady closed-loop load. Where is the throughput/429 knee?
 *
 * 2. Unknown and changing budget: the server tightens from 20 req/s to
 *    8 req/s mid-run. Fixed pacing at any single rate is wrong in one phase;
 *    AIMD (additive-increase, multiplicative-decrease on 429) knows nothing
 *    and adapts, measured against the perfectly informed oracle.
 */

import { runPacingStudy, type PacerSpec, type PacingStudyResult } from "./pacing-study.js";
import type { RetryOptions } from "./retry.js";

const RETRY: RetryOptions = {
  policy: { kind: "full-jitter", baseMs: 100, capMs: 10_000 },
  maxRetries: 8,
  respectRetryAfter: false,
};

const SERVER_RATE = 20;
const SERVER_BURST = 20;

const SWEEP_BASE = {
  clients: 20,
  requestsPerClient: 40,
  serverRatePerSec: SERVER_RATE,
  serverBurst: SERVER_BURST,
  faultRate: 0.02,
  latencyMsMin: 20,
  latencyMsMax: 60,
  advertiseRetryAfter: true,
  retry: RETRY,
  seed: 42,
};

const DROP_AT_MS = 30_000;
const DROPPED_RATE = 8;

const DROP_BASE = {
  ...SWEEP_BASE,
  requestsPerClient: 50,
  rateSchedule: [{ atMs: DROP_AT_MS, ratePerSec: DROPPED_RATE }],
  phaseBoundaryMs: DROP_AT_MS,
};

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

async function sweep(): Promise<void> {
  const totalRequests = SWEEP_BASE.clients * SWEEP_BASE.requestsPerClient;
  console.log(
    `part 1, pacing rate sweep: ${SWEEP_BASE.clients} clients x ${SWEEP_BASE.requestsPerClient} requests, ` +
      `server ${SERVER_RATE} req/s burst ${SERVER_BURST}, fault rate ${pct(SWEEP_BASE.faultRate)}, ` +
      `latency ${SWEEP_BASE.latencyMsMin}-${SWEEP_BASE.latencyMsMax}ms, seed ${SWEEP_BASE.seed}`,
  );
  console.log(
    `retry: full jitter base 100ms cap 10000ms, max 8 retries, Retry-After ignored; ` +
      `ideal makespan at the server rate ${((totalRequests - SERVER_BURST) / SERVER_RATE).toFixed(1)}s\n`,
  );

  const rates = [16, 18, 19, 20, 21, 22, 24];
  const results: PacingStudyResult[] = [];
  results.push(await runPacingStudy("unpaced", { kind: "none" }, SWEEP_BASE));
  for (const rate of rates) {
    results.push(
      await runPacingStudy(
        `paced-${rate}`,
        { kind: "fixed", ratePerSec: rate, burst: SERVER_BURST },
        SWEEP_BASE,
      ),
    );
  }

  const header = [
    "pacing".padEnd(10),
    "% of srv".padStart(8),
    "success".padStart(8),
    "attempts".padStart(9),
    "att/ok".padStart(7),
    "429s".padStart(6),
    "makespan".padStart(9),
    "ok/s".padStart(6),
  ].join("  ");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const r of results) {
    const rate = r.name === "unpaced" ? undefined : Number(r.name.split("-")[1]);
    console.log(
      [
        r.name.padEnd(10),
        (rate === undefined ? "-" : pct(rate / SERVER_RATE)).padStart(8),
        pct(r.succeeded / r.requests).padStart(8),
        fmt(r.totalAttempts).padStart(9),
        fmt(r.attemptsPerSuccess, 2).padStart(7),
        fmt(r.count429).padStart(6),
        `${fmt(r.makespanMs / 1000, 2)}s`.padStart(9),
        fmt(r.okPerSec, 2).padStart(6),
      ].join("  "),
    );
  }

  const byName = new Map(results.map((r) => [r.name, r]));
  const at80 = byName.get("paced-16")!;
  const at95 = byName.get("paced-19")!;
  const at100 = byName.get("paced-20")!;
  const at105 = byName.get("paced-21")!;
  const at120 = byName.get("paced-24")!;
  console.log("\nsweep findings:");
  console.log(
    `- below the budget the client rate IS the throughput: paced-16 delivers ${fmt(at80.okPerSec, 2)} ok/s ` +
      `with ${at80.count429} rejections, pure client-bound`,
  );
  console.log(
    `- pacing at exactly 100% leaves zero headroom for the 503-retry bypass: paced-19 takes ` +
      `${at95.count429} 429s at ${pct(at95.succeeded / at95.requests)} success, paced-20 takes ${at100.count429} at ` +
      `${pct(at100.succeeded / at100.requests)}. a ${pct(SWEEP_BASE.faultRate)} transient fault rate is enough to ` +
      `cascade once retries steal server tokens the pacer already promised away`,
  );
  console.log(
    `- above the budget throughput flatlines while waste climbs: paced-21 ${fmt(at105.okPerSec, 2)} ok/s at ` +
      `${at105.count429} 429s and ${fmt(at105.attemptsPerSuccess, 2)} att/ok, paced-24 ${fmt(at120.okPerSec, 2)} ok/s at ` +
      `${at120.count429} / ${fmt(at120.attemptsPerSuccess, 2)}, vs ${fmt(at95.attemptsPerSuccess, 2)} att/ok at 95%. ` +
      `the knee is sharp: every point of rate past it buys rejections and give-ups, not work\n`,
  );
}

async function adaptive(): Promise<void> {
  const totalRequests = DROP_BASE.clients * DROP_BASE.requestsPerClient;
  const phase1Capacity = SERVER_BURST + (SERVER_RATE * DROP_AT_MS) / 1000;
  const idealMakespanS =
    DROP_AT_MS / 1000 + (totalRequests - phase1Capacity) / DROPPED_RATE;
  console.log(
    `part 2, the budget drops mid-run: ${DROP_BASE.clients} clients x ${DROP_BASE.requestsPerClient} requests, ` +
      `server ${SERVER_RATE} req/s until t=${DROP_AT_MS / 1000}s then ${DROPPED_RATE} req/s, seed ${DROP_BASE.seed}`,
  );
  console.log(
    `aimd: start ${AIMD_SPEC.kind === "aimd" ? AIMD_SPEC.opts.initialRatePerSec : 0} req/s, ` +
      `+2 req/s per second, x0.6 per congestion event, 1s hold-off, burst 5; ` +
      `ideal makespan ${idealMakespanS.toFixed(1)}s\n`,
  );

  const specs: Array<[string, PacerSpec]> = [
    ["unpaced", { kind: "none" }],
    ["fixed-20", { kind: "fixed", ratePerSec: SERVER_RATE, burst: SERVER_BURST }],
    ["fixed-8", { kind: "fixed", ratePerSec: DROPPED_RATE, burst: SERVER_BURST }],
    ["oracle", { kind: "oracle", burst: SERVER_BURST }],
    ["aimd", AIMD_SPEC],
  ];
  const results: PacingStudyResult[] = [];
  for (const [name, spec] of specs) {
    results.push(await runPacingStudy(name, spec, { ...DROP_BASE, traceIntervalMs: 5000 }));
  }

  const header = [
    "strategy".padEnd(10),
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
        r.name.padEnd(10),
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

  const byName = new Map(results.map((r) => [r.name, r]));
  const unpaced = byName.get("unpaced")!;
  const fixed20 = byName.get("fixed-20")!;
  const fixed8 = byName.get("fixed-8")!;
  const oracle = byName.get("oracle")!;
  const aimd = byName.get("aimd")!;

  console.log(`\naimd rate trace (sampled every 5s, cuts taken: ${aimd.cuts}):`);
  console.log(
    aimd
      .rateTrace!.map((p) => `t=${(p.atMs / 1000).toFixed(0)}s ${p.ratePerSec.toFixed(1)}`)
      .join("  "),
  );

  console.log("\nadaptive findings:");
  console.log(
    `- every fixed rate is wrong in one phase: fixed-20 is clean until the drop ` +
      `(${fixed20.phase1Count429} phase-1 429s) then pays ${fixed20.phase2Count429} 429s and fails ` +
      `${pct(fixed20.failed / fixed20.requests)} of requests; fixed-8 never gets rejected ` +
      `(${fixed8.count429} 429s) but leaves ` +
      `${fmt(SERVER_RATE - fixed8.phase1OkPerSec!, 2)} req/s of phase-1 capacity unused and takes ` +
      `${fmt(fixed8.makespanMs / 1000, 2)}s`,
  );
  console.log(
    `- aimd knows neither rate and pays a makespan tax of ` +
      `${pct(aimd.makespanMs / oracle.makespanMs - 1)} over the oracle ` +
      `(${fmt(aimd.makespanMs / 1000, 2)}s vs ${fmt(oracle.makespanMs / 1000, 2)}s); the probing bill is ` +
      `${aimd.count429} 429s against unpaced's ${unpaced.count429}, and the tax lives in phase 1 ` +
      `(${fmt(aimd.phase1OkPerSec!, 2)} vs ${fmt(oracle.phase1OkPerSec!, 2)} ok/s: the ramp from ` +
      `${AIMD_SPEC.kind === "aimd" ? AIMD_SPEC.opts.initialRatePerSec : 0} req/s plus sawtooth troughs), ` +
      `not phase 2 (${fmt(aimd.phase2OkPerSec!, 2)} vs ${fmt(oracle.phase2OkPerSec!, 2)})`,
  );
  console.log(
    `- the informed client is not the safe one: oracle paces at exactly 100% and inherits the sweep's ` +
      `zero-headroom fragility, failing ${pct(oracle.failed / oracle.requests)} of requests to retry burnout ` +
      `where aimd fails ${pct(aimd.failed / aimd.requests)}. the sawtooth's troughs are accidental headroom ` +
      `that lets 503 retries land without cascading`,
  );
}

await sweep();
await adaptive();
