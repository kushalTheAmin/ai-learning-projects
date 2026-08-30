/**
 * Entry point for the circuit breaker studies:
 *   1. the dead service: what tripping the breaker saves when nobody can succeed
 *   2. outage recovery: what fail-fast costs on an outage the retries would survive
 *   3. the healthy herd: false trips when 429s count as failures
 * Same virtual clock, same seeds as the earlier studies, fresh server per run.
 */

import {
  runBreakerScenario,
  type BreakerConfig,
  type BreakerScenarioOptions,
  type BreakerScenarioResult,
  type BreakerStrategySpec,
} from "./breaker-study.js";
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

function retryOpts(policy: RetryOptions["policy"], respectRetryAfter = false): RetryOptions {
  return { policy, maxRetries: MAX_RETRIES, respectRetryAfter };
}

const FULL_JITTER = retryOpts({ kind: "full-jitter", baseMs: BASE_MS, capMs: CAP_MS });
const EQUAL_JITTER = retryOpts({ kind: "equal-jitter", baseMs: BASE_MS, capMs: CAP_MS });

function breaker(overrides: Partial<BreakerConfig>): BreakerConfig {
  return {
    failureThreshold: 5,
    openMs: 2_000,
    scope: "per-client",
    mode: "fail-fast",
    count429: false,
    ...overrides,
  };
}

async function studyDeadService(): Promise<void> {
  console.log("study 1: the dead service, now with a breaker");
  console.log(
    `same scenario as the outage extension's study 3 (40 clients x 3 sequential requests, ` +
      `every attempt an instant 503, no hints, seed ${SEED}), full-jitter retries, base ${BASE_MS}ms, ` +
      `cap ${CAP_MS / 1000}s, max ${MAX_RETRIES} retries. the no-breaker row is that study's ` +
      `exp-full-jitter row rerun through this harness\n`,
  );
  const opts: BreakerScenarioOptions = {
    clients: 40,
    requestsPerClient: 3,
    serverRatePerSec: 20,
    serverBurst: 20,
    faultRate: 0,
    latencyMsMin: 20,
    latencyMsMax: 60,
    advertiseRetryAfter: false,
    outageMs: Number.POSITIVE_INFINITY,
    advertiseOutageRetryAfter: false,
    seed: SEED,
  };
  const rows: BreakerStrategySpec[] = [
    { name: "no-breaker", retry: FULL_JITTER },
    { name: "k=3 fail-fast", retry: FULL_JITTER, breaker: breaker({ failureThreshold: 3 }) },
    { name: "k=5 fail-fast", retry: FULL_JITTER, breaker: breaker({}) },
    { name: "k=5 wait", retry: FULL_JITTER, breaker: breaker({ mode: "wait" }) },
    { name: "k=5 shared", retry: FULL_JITTER, breaker: breaker({ scope: "shared" }) },
  ];
  const header = [
    "strategy".padEnd(15),
    "wire att".padStart(9),
    "att/req".padStart(8),
    "rejected".padStart(9),
    "trips".padStart(6),
    "probes".padStart(7),
    "makespan".padStart(9),
    "give-up p50 req1".padStart(17),
    "later reqs".padStart(11),
  ].join("  ");
  console.log(header);
  console.log("-".repeat(header.length));
  const results: BreakerScenarioResult[] = [];
  for (const row of rows) {
    const r = await runBreakerScenario(row, opts);
    results.push(r);
    console.log(
      [
        r.name.padEnd(15),
        fmt(r.wireAttempts).padStart(9),
        fmt(r.wireAttempts / r.requests, 1).padStart(8),
        fmt(r.breakerRejections).padStart(9),
        fmt(r.trips).padStart(6),
        fmt(r.probes).padStart(7),
        fmtSec(r.makespanMs).padStart(9),
        fmtSec(r.firstGiveUpP50Ms).padStart(17),
        fmtSec(r.laterGiveUpP50Ms).padStart(11),
      ].join("  "),
    );
  }
  const base = results[0]!;
  const k5 = results[2]!;
  const wait = results[3]!;
  const shared = results[4]!;
  console.log("\nfindings:");
  console.log(
    `- fail-fast is what collapses the bill: k=5 spends ${fmt(k5.wireAttempts)} wire attempts ` +
      `(${fmt(k5.wireAttempts / k5.requests, 1)}/request) against the no-breaker ${fmt(base.wireAttempts)}, ` +
      `${pct(1 - k5.wireAttempts / base.wireAttempts)} of the traffic gone, and later requests hear ` +
      `"no" in ${fmtSec(k5.laterGiveUpP50Ms)} instead of ${fmtSec(base.laterGiveUpP50Ms)}`,
  );
  console.log(
    `- wait mode does not shrink the bill: ${fmt(wait.wireAttempts)} attempts, same as no ` +
      `breaker, because the budget is counted in attempts and every probe window mints another ` +
      `probe until the budget is gone. probes fire at max(backoff, cooldown), so callers hang ` +
      `longer: later requests give up at ${fmtSec(wait.laterGiveUpP50Ms)} p50 vs ` +
      `${fmtSec(base.laterGiveUpP50Ms)} with no breaker`,
  );
  console.log(
    `- the shared breaker's floor is the concurrency width, not k: all 40 clients are already ` +
      `in flight when it trips, so ${fmt(shared.wireAttempts)} attempts land before the gate ` +
      `closes, then every remaining request is rejected without touching the wire ` +
      `(${fmt(shared.breakerRejections)} rejections, ${fmt(shared.trips)} trip)`,
  );
}

interface GridRow {
  spec: BreakerStrategySpec;
  results: Map<number, BreakerScenarioResult>;
}

async function studyOutageRecovery(): Promise<void> {
  console.log("\nstudy 2: the survivable outage");
  console.log(
    `40 clients x 1 request at t=0, server hard-down over [0, outage) then healthy at 20 req/s ` +
      `burst 20, seed ${SEED}. equal-jitter retries (the schedule that survived every outage up ` +
      `to 10s in the outage extension), hints advertised but not respected, so the breaker is ` +
      `the only thing that changes between rows\n`,
  );
  const outages = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000];
  const rows: BreakerStrategySpec[] = [
    { name: "no-breaker", retry: EQUAL_JITTER },
    { name: "k=5 fail-fast 2s", retry: EQUAL_JITTER, breaker: breaker({}) },
    { name: "k=5 wait 2s", retry: EQUAL_JITTER, breaker: breaker({ mode: "wait" }) },
    { name: "k=5 wait 5s", retry: EQUAL_JITTER, breaker: breaker({ mode: "wait", openMs: 5_000 }) },
  ];
  const grid: GridRow[] = [];
  const gridHeader = [
    "success by outage".padEnd(18),
    ...outages.map((o) => `${o / 1000}s`.padStart(7)),
  ].join("  ");
  console.log(gridHeader);
  console.log("-".repeat(gridHeader.length));
  for (const spec of rows) {
    const results = new Map<number, BreakerScenarioResult>();
    const cells: string[] = [];
    for (const outageMs of outages) {
      const r = await runBreakerScenario(spec, {
        clients: 40,
        requestsPerClient: 1,
        serverRatePerSec: 20,
        serverBurst: 20,
        faultRate: 0,
        latencyMsMin: 20,
        latencyMsMax: 60,
        advertiseRetryAfter: true,
        outageMs,
        advertiseOutageRetryAfter: true,
        seed: SEED,
      });
      results.set(outageMs, r);
      cells.push(pct(r.succeeded / r.requests).padStart(7));
    }
    grid.push({ spec, results });
    console.log([spec.name.padEnd(18), ...cells].join("  "));
  }

  console.log("\ndetail at the 5s outage:");
  const header = [
    "strategy".padEnd(18),
    "success".padStart(8),
    "wire att".padStart(9),
    "wasted".padStart(7),
    "probes".padStart(7),
    "makespan".padStart(9),
    "give-up p50".padStart(12),
  ].join("  ");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const row of grid) {
    const r = row.results.get(5_000)!;
    console.log(
      [
        r.name.padEnd(18),
        pct(r.succeeded / r.requests).padStart(8),
        fmt(r.wireAttempts).padStart(9),
        fmt(r.attemptsDuringOutage).padStart(7),
        fmt(r.probes).padStart(7),
        fmtSec(r.makespanMs).padStart(9),
        fmtSec(r.giveUpP50Ms).padStart(12),
      ].join("  "),
    );
  }

  const at = (name: string, outageMs: number): BreakerScenarioResult =>
    grid.find((g) => g.spec.name === name)!.results.get(outageMs)!;
  const ff5 = at("k=5 fail-fast 2s", 5_000);
  const ff1 = at("k=5 fail-fast 2s", 1_000);
  const base5 = at("no-breaker", 5_000);
  const base20 = at("no-breaker", 20_000);
  const wait2At5 = at("k=5 wait 2s", 5_000);
  const wait5At5 = at("k=5 wait 5s", 5_000);
  const wait2At20 = at("k=5 wait 2s", 20_000);
  const wait5At20 = at("k=5 wait 5s", 20_000);
  console.log("\nfindings:");
  console.log(
    `- fail-fast turns a survivable outage into a lost one: at 5s the plain schedule lands ` +
      `${pct(base5.succeeded / base5.requests)} and the k=5 fail-fast breaker ` +
      `${pct(ff5.succeeded / ff5.requests)}, giving up at ${fmtSec(ff5.giveUpP50Ms)} p50 with ` +
      `recovery ${fmtSec(5_000 - ff5.giveUpP50Ms, 1)} away. even the 1s outage keeps only ` +
      `${pct(ff1.succeeded / ff1.requests)}: whoever burns 5 attempts before recovery is done for`,
  );
  console.log(
    `- wait mode keeps every outage the plain schedule survives (100% through 10s) and wastes ` +
      `less doing it: at 5s, ${fmt(wait2At5.wireAttempts)} wire attempts with 2s cooldowns and ` +
      `${fmt(wait5At5.wireAttempts)} with 5s vs the plain ${fmt(base5.wireAttempts)}`,
  );
  console.log(
    `- the cooldown acts as a delay floor on the probe schedule (probes fire at ` +
      `max(backoff, cooldown)), so a longer cooldown stretches the same ${1 + MAX_RETRIES}-attempt ` +
      `budget over a longer horizon: at the 20s outage the plain schedule keeps ` +
      `${pct(base20.succeeded / base20.requests)}, wait-2s ${pct(wait2At20.succeeded / wait2At20.requests)}, ` +
      `wait-5s ${pct(wait5At20.succeeded / wait5At20.requests)}. nobody outlives 30s; the budget still ends`,
  );
}

async function studyHealthyHerd(): Promise<void> {
  console.log("\nstudy 3: false trips on the healthy herd");
  console.log(
    `the main table's herd (40 clients x 5 requests, 20 req/s burst 20, 2% transient faults, ` +
      `seed ${SEED}) with the main table's best guessing strategy, full-jitter+retry-after. ` +
      `the server is fine; every failure is a 429 the herd caused itself, plus the odd ` +
      `transient 503. whether the breaker counts 429s is the whole story\n`,
  );
  const opts: BreakerScenarioOptions = {
    clients: 40,
    requestsPerClient: 5,
    serverRatePerSec: 20,
    serverBurst: 20,
    faultRate: 0.02,
    latencyMsMin: 20,
    latencyMsMax: 60,
    advertiseRetryAfter: true,
    outageMs: 0,
    advertiseOutageRetryAfter: false,
    seed: SEED,
  };
  const retry = retryOpts({ kind: "full-jitter", baseMs: BASE_MS, capMs: CAP_MS }, true);
  const rows: BreakerStrategySpec[] = [
    { name: "no-breaker", retry },
    { name: "k=3 counts 429", retry, breaker: breaker({ failureThreshold: 3, count429: true }) },
    { name: "k=5 counts 429", retry, breaker: breaker({ count429: true }) },
    { name: "k=5 503s only", retry, breaker: breaker({}) },
    { name: "k=5 shared 429", retry, breaker: breaker({ count429: true, scope: "shared" }) },
  ];
  const header = [
    "strategy".padEnd(16),
    "success".padStart(8),
    "wire att".padStart(9),
    "429s".padStart(6),
    "trips".padStart(6),
    "fast-fail".padStart(10),
    "makespan".padStart(9),
  ].join("  ");
  console.log(header);
  console.log("-".repeat(header.length));
  const results: BreakerScenarioResult[] = [];
  for (const row of rows) {
    const r = await runBreakerScenario(row, opts);
    results.push(r);
    console.log(
      [
        r.name.padEnd(16),
        pct(r.succeeded / r.requests).padStart(8),
        fmt(r.wireAttempts).padStart(9),
        fmt(r.count429).padStart(6),
        fmt(r.trips).padStart(6),
        fmt(r.fastFailed).padStart(10),
        fmtSec(r.makespanMs).padStart(9),
      ].join("  "),
    );
  }
  const base = results[0]!;
  const k3 = results[1]!;
  const k5 = results[2]!;
  const only503 = results[3]!;
  const shared = results[4]!;
  console.log("\nfindings:");
  console.log(
    `- counting 429s makes herd congestion look like a dead dependency: k=3 trips ` +
      `${fmt(k3.trips)} times and fails ${fmt(k3.fastFailed)} requests fast on a server that ` +
      `is up the whole time, success ${pct(k3.succeeded / k3.requests)} vs the no-breaker ` +
      `${pct(base.succeeded / base.requests)}; k=5 trips ${fmt(k5.trips)} times ` +
      `(${pct(k5.succeeded / k5.requests)})`,
  );
  console.log(
    `- counting only 503s, the breaker never fires (${fmt(only503.trips)} trips) and the run is ` +
      `the baseline to the attempt: ${fmt(only503.wireAttempts)} vs ${fmt(base.wireAttempts)} wire ` +
      `attempts. 2% transient faults cannot produce 5 consecutive counted failures`,
  );
  console.log(
    `- scope multiplies the blast radius: the shared 429-counting breaker sees the herd's ` +
      `rejections as one failure streak (${fmt(shared.trips)} trip), and takes the whole ` +
      `run down to ${pct(shared.succeeded / shared.requests)} success. per-client false trips ` +
      `cost one client's requests; shared false trips cost everyone's`,
  );
}

async function main(): Promise<void> {
  await studyDeadService();
  await studyOutageRecovery();
  await studyHealthyHerd();
}

await main();
