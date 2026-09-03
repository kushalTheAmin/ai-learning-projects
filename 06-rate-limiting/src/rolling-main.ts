/**
 * Entry point for the rolling-window breaker studies: the consecutive-count
 * detector against the rate-over-a-window detector production breakers use,
 * on the same scenarios as the breaker extension.
 *   1. the dead service: both detectors trip, but volume decides who can
 *   2. the flaky-but-healthy service: chance streaks vs a rate threshold
 *   3. the healthy herd counting 429s: a better detector cannot fix a wrong signal
 *   4. the survivable outage: recovery behavior with a rolling detector
 */

import {
  runBreakerScenario,
  type BreakerConfig,
  type BreakerScenarioOptions,
  type BreakerScenarioResult,
  type BreakerStrategySpec,
  type FailureDetector,
} from "./breaker-study.js";
import type { RetryOptions } from "./retry.js";

const BASE_MS = 100;
const CAP_MS = 10_000;
const MAX_RETRIES = 8;
const SEED = 42;

const CONSECUTIVE_5: FailureDetector = { kind: "consecutive", failureThreshold: 5 };
const ROLLING_V20: FailureDetector = { kind: "rolling", windowMs: 1_000, errorRateThreshold: 0.5, minVolume: 20 };
const ROLLING_V5: FailureDetector = { kind: "rolling", windowMs: 1_000, errorRateThreshold: 0.5, minVolume: 5 };

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

function breaker(detector: FailureDetector, overrides: Partial<Omit<BreakerConfig, "detector">> = {}): BreakerConfig {
  return { detector, openMs: 2_000, scope: "per-client", mode: "fail-fast", count429: false, ...overrides };
}

async function studyDeadService(): Promise<void> {
  console.log("study 1: the dead service, detector vs detector");
  console.log(
    `the breaker extension's study 1 scenario (40 clients x 3 sequential requests, every ` +
      `attempt an instant 503, no hints, seed ${SEED}), full-jitter retries, base ${BASE_MS}ms, ` +
      `cap ${CAP_MS / 1000}s, max ${MAX_RETRIES} retries. rolling rows are 50% error rate over a ` +
      `1s window; v is the minimum volume before the rate is judged\n`,
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
    { name: "cons k=5", retry: FULL_JITTER, breaker: breaker(CONSECUTIVE_5) },
    { name: "roll v5", retry: FULL_JITTER, breaker: breaker(ROLLING_V5) },
    { name: "roll v20", retry: FULL_JITTER, breaker: breaker(ROLLING_V20) },
    { name: "roll v20 shared", retry: FULL_JITTER, breaker: breaker(ROLLING_V20, { scope: "shared" }) },
  ];
  const header = [
    "strategy".padEnd(16),
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
        r.name.padEnd(16),
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
  const cons = results[1]!;
  const v5 = results[2]!;
  const v20 = results[3]!;
  const shared = results[4]!;
  console.log("\nfindings:");
  console.log(
    `- on a dead service the rate detector at reachable volume behaves like the counter: ` +
      `roll v5 spends ${fmt(v5.wireAttempts)} wire attempts and trips ${fmt(v5.trips)} times ` +
      `vs cons k=5 at ${fmt(cons.wireAttempts)} and ${fmt(cons.trips)}; 100% failure clears ` +
      `any rate threshold as soon as the volume floor is met`,
  );
  console.log(
    `- volume is the blind spot: per-client roll v20 needs 20 settles inside one 1s window ` +
      `from a single caller whose backoff is stretching toward ${CAP_MS / 1000}s, so it trips ` +
      `${fmt(v20.trips)} times and spends ${fmt(v20.wireAttempts)} attempts against the ` +
      `no-breaker's ${fmt(base.wireAttempts)}: a breaker that can never fire, priced at the ` +
      `full no-breaker bill`,
  );
  console.log(
    `- the same v20 shared sees all 40 clients' settles in one window and trips on the ` +
      `20th settle: ${fmt(shared.wireAttempts)} attempts, ${fmt(shared.breakerRejections)} ` +
      `rejections. the rate detector wants aggregate traffic; scope is not a tuning detail ` +
      `for it, it is the difference between working and inert`,
  );
}

interface CellAggregate {
  runs: number;
  trippedRuns: number;
  meanTrips: number;
  meanFastFailed: number;
  meanSuccessRate: number;
}

async function aggregate(
  spec: BreakerStrategySpec,
  opts: Omit<BreakerScenarioOptions, "seed">,
  seeds: readonly number[],
): Promise<CellAggregate> {
  let trippedRuns = 0;
  let trips = 0;
  let fastFailed = 0;
  let successRate = 0;
  for (const seed of seeds) {
    const r = await runBreakerScenario(spec, { ...opts, seed });
    if (r.trips > 0) trippedRuns++;
    trips += r.trips;
    fastFailed += r.fastFailed;
    successRate += r.succeeded / r.requests;
  }
  return {
    runs: seeds.length,
    trippedRuns,
    meanTrips: trips / seeds.length,
    meanFastFailed: fastFailed / seeds.length,
    meanSuccessRate: successRate / seeds.length,
  };
}

async function studyFlakyHealthy(): Promise<void> {
  const seeds = Array.from({ length: 20 }, (_, i) => 1000 + i);
  console.log("\nstudy 2: chance streaks on the flaky-but-healthy service");
  console.log(
    `40 clients x 10 requests against a server with capacity to spare (4000 req/s, burst 4000, ` +
      `zero 429s) and a swept transient 503 rate. full-jitter retries, max ${MAX_RETRIES}: with 9 ` +
      `attempts a request survives any fault rate on this sweep short of the brownout, so every ` +
      `fast-failed request is a success the breaker threw away. shared scope, 503s only, ` +
      `${seeds.length} seeds per cell; "tripped" is runs with at least one trip\n`,
  );
  const faultRates = [0.05, 0.1, 0.2, 0.3, 0.7];
  const rows: { name: string; spec: BreakerStrategySpec }[] = [
    { name: "cons k=5 shared", spec: { name: "cons", retry: FULL_JITTER, breaker: breaker(CONSECUTIVE_5, { scope: "shared" }) } },
    { name: "roll v20 shared", spec: { name: "roll", retry: FULL_JITTER, breaker: breaker(ROLLING_V20, { scope: "shared" }) } },
  ];
  const header = [
    "fault rate".padEnd(10),
    ...rows.map((r) => `${r.name}: tripped  trips  fastfail  success`.padStart(46)),
  ].join("  ");
  console.log(header);
  console.log("-".repeat(header.length));
  const cells = new Map<string, CellAggregate>();
  for (const faultRate of faultRates) {
    const opts: Omit<BreakerScenarioOptions, "seed"> = {
      clients: 40,
      requestsPerClient: 10,
      serverRatePerSec: 4000,
      serverBurst: 4000,
      faultRate,
      latencyMsMin: 20,
      latencyMsMax: 60,
      advertiseRetryAfter: false,
      outageMs: 0,
      advertiseOutageRetryAfter: false,
    };
    const line: string[] = [pct(faultRate).padEnd(10)];
    for (const row of rows) {
      const a = await aggregate(row.spec, opts, seeds);
      cells.set(`${row.name}@${faultRate}`, a);
      line.push(
        [
          `${a.trippedRuns}/${a.runs}`.padStart(24),
          fmt(a.meanTrips, 2).padStart(6),
          fmt(a.meanFastFailed, 1).padStart(9),
          pct(a.meanSuccessRate).padStart(8),
        ].join(" "),
      );
    }
    console.log(line.join("  "));
  }
  const cons20 = cells.get("cons k=5 shared@0.2")!;
  const cons30 = cells.get("cons k=5 shared@0.3")!;
  const roll30 = cells.get("roll v20 shared@0.3")!;
  const cons70 = cells.get("cons k=5 shared@0.7")!;
  const roll70 = cells.get("roll v20 shared@0.7")!;
  console.log("\nfindings:");
  console.log(
    `- the counter false-trips on luck: at 30% faults it trips in ${cons30.trippedRuns} of ` +
      `${cons30.runs} runs (${cons20.trippedRuns}/${cons20.runs} at 20%), on a server where ` +
      `every one of those requests would have succeeded: mean ${fmt(cons30.meanFastFailed, 1)} ` +
      `requests fast-failed per 30% run, success ${pct(cons30.meanSuccessRate)}. five bad draws ` +
      `in a row is not an incident, it is arithmetic: ~0.3^5 per settle, times hundreds of settles`,
  );
  console.log(
    `- the rate detector holds: at 30% faults it trips in ${roll30.trippedRuns} of ` +
      `${roll30.runs} runs (success ${pct(roll30.meanSuccessRate)}), because 30% never looks ` +
      `like 50% over 20+ settles for long enough to matter. one worker's streak is diluted by ` +
      `everyone else's successes in the same window, which is exactly the thread's claim`,
  );
  console.log(
    `- both fire on the real incident: at the 70% brownout cons trips in ${cons70.trippedRuns}/20 ` +
      `and roll in ${roll70.trippedRuns}/20 runs. the difference between the detectors is not ` +
      `sensitivity to disasters, it is the false-positive bill on the wide healthy-but-imperfect ` +
      `middle where production services actually live`,
  );
}

async function studyHerd429(): Promise<void> {
  console.log("\nstudy 3: the healthy herd, counting 429s");
  console.log(
    `the breaker extension's study 3 scenario (40 clients x 5 requests, 20 req/s burst 20, 2% ` +
      `transient faults, seed ${SEED}), full-jitter+retry-after. the herd's own burst makes real ` +
      `429s; the question is whether a rate detector saves a breaker that counts them\n`,
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
    { name: "cons k=5 429", retry, breaker: breaker(CONSECUTIVE_5, { scope: "shared", count429: true }) },
    { name: "roll v20 429", retry, breaker: breaker(ROLLING_V20, { scope: "shared", count429: true }) },
    { name: "roll v20 503s", retry, breaker: breaker(ROLLING_V20, { scope: "shared" }) },
  ];
  const header = [
    "strategy".padEnd(15),
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
        r.name.padEnd(15),
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
  const cons = results[1]!;
  const roll429 = results[2]!;
  const roll503 = results[3]!;
  console.log("\nfindings:");
  console.log(
    `- the rate detector does not save a wrong predicate: at t=0 the herd's first wave takes ` +
      `${opts.serverBurst} admissions and the rest bounce, a genuine >=50% 429 rate in the ` +
      `window, so roll-429 trips (${fmt(roll429.trips)} trip) and lands ` +
      `${pct(roll429.succeeded / roll429.requests)} vs cons-429's ` +
      `${pct(cons.succeeded / cons.requests)} (no-breaker: ${pct(base.succeeded / base.requests)}). ` +
      `the window measured the truth; the truth was the wrong signal`,
  );
  console.log(
    `- counting only 503s the same detector never fires (${fmt(roll503.trips)} trips, success ` +
      `${pct(roll503.succeeded / roll503.requests)}): 2% transient faults diluted across the ` +
      `herd's settles never approach 50%. detector choice tunes false-trip odds; predicate ` +
      `choice decides what a trip means`,
  );
}

async function studyOutageRecovery(): Promise<void> {
  console.log("\nstudy 4: the survivable outage with a rolling detector");
  console.log(
    `the breaker extension's study 2 scenario: 40 clients x 1 request at t=0, server hard-down ` +
      `over [0, outage) then healthy at 20 req/s burst 20, seed ${SEED}, equal-jitter retries, ` +
      `hints advertised but not respected. per-client rolling is volume-starved by construction ` +
      `here (one request makes at most ${1 + MAX_RETRIES} settles, spread by backoff)\n`,
  );
  const outages = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000];
  const rows: BreakerStrategySpec[] = [
    { name: "no-breaker", retry: EQUAL_JITTER },
    { name: "cons k=5 ff 2s", retry: EQUAL_JITTER, breaker: breaker(CONSECUTIVE_5) },
    { name: "roll v5 ff 2s", retry: EQUAL_JITTER, breaker: breaker(ROLLING_V5) },
    { name: "roll v20 sh ff", retry: EQUAL_JITTER, breaker: breaker(ROLLING_V20, { scope: "shared" }) },
    { name: "roll v20 sh wait", retry: EQUAL_JITTER, breaker: breaker(ROLLING_V20, { scope: "shared", mode: "wait" }) },
  ];
  const grid: { spec: BreakerStrategySpec; results: Map<number, BreakerScenarioResult> }[] = [];
  const gridHeader = ["success by outage".padEnd(18), ...outages.map((o) => `${o / 1000}s`.padStart(7))].join("  ");
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
  const at = (name: string, outageMs: number): BreakerScenarioResult =>
    grid.find((g) => g.spec.name === name)!.results.get(outageMs)!;
  const consFf5 = at("cons k=5 ff 2s", 5_000);
  const rollFf5 = at("roll v5 ff 2s", 5_000);
  const sharedFf5 = at("roll v20 sh ff", 5_000);
  const sharedWait5 = at("roll v20 sh wait", 5_000);
  const sharedWait20 = at("roll v20 sh wait", 20_000);
  const sharedWait30 = at("roll v20 sh wait", 30_000);
  const base20 = at("no-breaker", 20_000);
  console.log("\ndetail at the 5s outage:");
  for (const name of ["no-breaker", "cons k=5 ff 2s", "roll v5 ff 2s", "roll v20 sh ff", "roll v20 sh wait"]) {
    const r = at(name, 5_000);
    console.log(
      `  ${r.name.padEnd(18)} success ${pct(r.succeeded / r.requests).padStart(6)}  wire ${fmt(r.wireAttempts).padStart(4)}  ` +
        `wasted ${fmt(r.attemptsDuringOutage).padStart(4)}  trips ${fmt(r.trips).padStart(3)}  probes ${fmt(r.probes).padStart(3)}  ` +
        `give-up p50 ${fmtSec(r.giveUpP50Ms)}`,
    );
  }
  console.log("\nfindings:");
  console.log(
    `- fail-fast loses the survivable outage under either detector: at 5s cons k=5 keeps ` +
      `${pct(consFf5.succeeded / consFf5.requests)} and roll v20 shared ` +
      `${pct(sharedFf5.succeeded / sharedFf5.requests)}; the detector decides when the gate ` +
      `closes, the mode decides what closing costs, and it is the mode that loses the requests`,
  );
  console.log(
    `- per-client roll v5 trips ${fmt(rollFf5.trips)} times at the 5s outage: equal-jitter ` +
      `spreads a lone caller's settles past the 1s window about as fast as they accrue, so the ` +
      `detector hovers at the volume floor. the same backoff that protects the server starves ` +
      `the client's own rolling window of evidence`,
  );
  console.log(
    `- wait mode behind the shared gate outlives every outage on the grid, including the ones ` +
      `the plain schedule loses: ${pct(sharedWait20.succeeded / sharedWait20.requests)} at 20s ` +
      `vs no-breaker ${pct(base20.succeeded / base20.requests)}, ` +
      `${pct(sharedWait30.succeeded / sharedWait30.requests)} at 30s vs 0%. one shared gate ` +
      `spends one probe per cooldown for the whole herd while sleepers spend nothing, so no ` +
      `client's ${1 + MAX_RETRIES}-attempt budget ever runs out waiting; the price is hang time ` +
      `(makespan ${fmtSec(sharedWait30.makespanMs)} at 30s, ${fmt(sharedWait5.wireAttempts)} ` +
      `wire attempts at 5s vs the plain ${fmt(at("no-breaker", 5_000).wireAttempts)})`,
  );
}

async function main(): Promise<void> {
  await studyDeadService();
  await studyFlakyHealthy();
  await studyHerd429();
  await studyOutageRecovery();
}

await main();
