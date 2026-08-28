/**
 * Entry point: one thundering-herd scenario, eight retry strategies, same
 * seeds, fresh server each, then the numbers side by side.
 *
 * Scenario: 40 clients each fire 5 sequential requests starting at t=0
 * against an API budgeted at 20 req/s with a burst of 20. Admitted requests
 * take 20-60ms and fail transiently 2% of the time. Ideal makespan is
 * (200 - 20 burst) / 20 req/s = 9.0s of virtual time.
 */

import { runScenario, type ScenarioOptions, type StrategySpec } from "./experiment.js";

const BASE_MS = 100;
const CAP_MS = 10_000;
const MAX_RETRIES = 8;

const SCENARIO: ScenarioOptions = {
  clients: 40,
  requestsPerClient: 5,
  serverRatePerSec: 20,
  serverBurst: 20,
  faultRate: 0.02,
  latencyMsMin: 20,
  latencyMsMax: 60,
  advertiseRetryAfter: true,
  seed: 42,
  peakWindowMs: 100,
};

const STRATEGIES: StrategySpec[] = [
  {
    name: "no-retry",
    retry: { policy: { kind: "none" }, maxRetries: 0, respectRetryAfter: false },
  },
  {
    name: "fixed-100ms",
    retry: {
      policy: { kind: "fixed", delayMs: BASE_MS },
      maxRetries: MAX_RETRIES,
      respectRetryAfter: false,
    },
  },
  {
    name: "exp-no-jitter",
    retry: {
      policy: { kind: "exponential", baseMs: BASE_MS, capMs: CAP_MS },
      maxRetries: MAX_RETRIES,
      respectRetryAfter: false,
    },
  },
  {
    name: "exp-full-jitter",
    retry: {
      policy: { kind: "full-jitter", baseMs: BASE_MS, capMs: CAP_MS },
      maxRetries: MAX_RETRIES,
      respectRetryAfter: false,
    },
  },
  {
    name: "exp-equal-jitter",
    retry: {
      policy: { kind: "equal-jitter", baseMs: BASE_MS, capMs: CAP_MS },
      maxRetries: MAX_RETRIES,
      respectRetryAfter: false,
    },
  },
  {
    name: "decorrelated",
    retry: {
      policy: { kind: "decorrelated-jitter", baseMs: BASE_MS, capMs: CAP_MS },
      maxRetries: MAX_RETRIES,
      respectRetryAfter: false,
    },
  },
  {
    name: "full-jitter+retry-after",
    retry: {
      policy: { kind: "full-jitter", baseMs: BASE_MS, capMs: CAP_MS },
      maxRetries: MAX_RETRIES,
      respectRetryAfter: true,
    },
  },
  {
    name: "full-jitter+pacing",
    retry: {
      policy: { kind: "full-jitter", baseMs: BASE_MS, capMs: CAP_MS },
      maxRetries: MAX_RETRIES,
      respectRetryAfter: false,
    },
    clientPacing: { ratePerSec: SCENARIO.serverRatePerSec, burst: SCENARIO.serverBurst },
  },
];

function fmt(value: number, digits = 0): string {
  return Number.isNaN(value) ? "-" : value.toFixed(digits);
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const results = [];
  for (const spec of STRATEGIES) {
    results.push(await runScenario(spec, SCENARIO));
  }

  const totalRequests = SCENARIO.clients * SCENARIO.requestsPerClient;
  console.log(
    `scenario: ${SCENARIO.clients} clients x ${SCENARIO.requestsPerClient} requests at t=0, ` +
      `server ${SCENARIO.serverRatePerSec} req/s burst ${SCENARIO.serverBurst}, ` +
      `fault rate ${pct(SCENARIO.faultRate)}, latency ${SCENARIO.latencyMsMin}-${SCENARIO.latencyMsMax}ms, seed ${SCENARIO.seed}`,
  );
  console.log(
    `retry budget: base ${BASE_MS}ms, cap ${CAP_MS}ms, max ${MAX_RETRIES} retries; ` +
      `ideal makespan ${(((totalRequests - SCENARIO.serverBurst) / SCENARIO.serverRatePerSec)).toFixed(1)}s\n`,
  );

  const header = [
    "strategy".padEnd(24),
    "success".padStart(8),
    "attempts".padStart(9),
    "att/ok".padStart(7),
    "429s".padStart(6),
    "503s".padStart(5),
    "makespan".padStart(9),
    "p50 ok".padStart(7),
    "p99 ok".padStart(8),
    "p50 all".padStart(8),
    "peak/100ms".padStart(11),
    "collide".padStart(8),
  ].join("  ");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const r of results) {
    console.log(
      [
        r.name.padEnd(24),
        pct(r.succeeded / r.requests).padStart(8),
        fmt(r.totalAttempts).padStart(9),
        fmt(r.attemptsPerSuccess, 2).padStart(7),
        fmt(r.count429).padStart(6),
        fmt(r.count503).padStart(5),
        `${fmt(r.makespanMs / 1000, 2)}s`.padStart(9),
        `${fmt(r.p50LatencyMs)}ms`.padStart(7),
        `${fmt(r.p99LatencyMs)}ms`.padStart(8),
        `${fmt(r.p50AllMs)}ms`.padStart(8),
        fmt(r.peakArrivalsPerWindow).padStart(11),
        fmt(r.maxSimultaneousRetries).padStart(8),
      ].join("  "),
    );
  }

  const byName = new Map(results.map((r) => [r.name, r]));
  const noJitter = byName.get("exp-no-jitter")!;
  const fullJitter = byName.get("exp-full-jitter")!;
  const retryAfter = byName.get("full-jitter+retry-after")!;
  const pacing = byName.get("full-jitter+pacing")!;
  const fixed = byName.get("fixed-100ms")!;
  const noRetry = byName.get("no-retry")!;

  console.log(
    `\n'p50 ok' and 'p99 ok' cover requests that succeeded; 'p50 all' covers every ` +
      `request, give-ups included. read the ok columns down the table only where ` +
      `success rates match.`,
  );

  console.log("\nfindings:");
  console.log(
    `- synchronization, not volume, is what jitter fixes: exp-no-jitter retries collide ` +
      `${noJitter.maxSimultaneousRetries}-wide at the same instant vs ${fullJitter.maxSimultaneousRetries} with full jitter. ` +
      `full jitter's peak-window load is actually higher (${fullJitter.peakArrivalsPerWindow} vs ` +
      `${noJitter.peakArrivalsPerWindow} arrivals/100ms) because its mean delay is half the exponential, ` +
      `it retries sooner, just never in lockstep (p50 ${fmt(fullJitter.p50LatencyMs)}ms vs ${fmt(noJitter.p50LatencyMs)}ms)`,
  );
  console.log(
    `- wasted work: fixed-100ms hammers ${fixed.totalAttempts} attempts for ${fixed.succeeded} successes ` +
      `(${fixed.attemptsPerSuccess.toFixed(2)} att/ok) and still fails ${pct(fixed.failed / fixed.requests)} of requests; ` +
      `every exponential variant lands near ${fullJitter.attemptsPerSuccess.toFixed(2)} att/ok`,
  );
  console.log(
    `- a latency measured only over successes flatters whatever gives up most: no-retry ` +
      `looks like the fastest strategy in the table at ${fmt(noRetry.p50LatencyMs)}ms p50 ok, but ` +
      `${pct(noRetry.failed / noRetry.requests)} of its requests were rejected instantly, so its median ` +
      `request took ${fmt(noRetry.p50AllMs)}ms. fixed-100ms reads ${fmt(fixed.p50LatencyMs)}ms ok vs ` +
      `${fmt(fixed.p50AllMs)}ms over every request, because a give-up burns the full ` +
      `${MAX_RETRIES}-retry budget before it counts as anything`,
  );
  console.log(
    `- the server knows best: honoring Retry-After finishes in ${(retryAfter.makespanMs / 1000).toFixed(2)}s, ` +
      `closest to the 9.0s ideal, vs ${(noJitter.makespanMs / 1000).toFixed(2)}s (no jitter) and ` +
      `${(fullJitter.makespanMs / 1000).toFixed(2)}s (full jitter) spent guessing`,
  );
  console.log(
    `- client pacing turns ${fullJitter.count429} rejections into ${pacing.count429} and ` +
      `${fullJitter.attemptsPerSuccess.toFixed(2)} att/ok into ${pacing.attemptsPerSuccess.toFixed(2)}, but pacing at ` +
      `exactly the server rate leaves no headroom: makespan ${(pacing.makespanMs / 1000).toFixed(2)}s. ` +
      `${pacing.count429OnFirstAttempt} of the ${pacing.count429} leftover 429s hit a paced first attempt; ` +
      `the rest land on retries of the ${pacing.count503} transient 503s, which re-enter without a pacing token`,
  );
}

await main();
