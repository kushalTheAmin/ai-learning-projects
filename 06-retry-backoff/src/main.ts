/**
 * Compares retry policies under three simulated failure scenarios and prints
 * the measured numbers. Simulated time throughout — a full run is instant.
 */
import {
  decorrelatedJitter,
  exponential,
  exponentialEqualJitter,
  exponentialFullJitter,
  fixedDelay,
  immediate,
  retryAfterExact,
  retryAfterJitter,
  type RetryPolicy,
} from "./policies.js";
import { runScenario, type Scenario } from "./scenario.js";
import type { ScenarioMetrics } from "./metrics.js";

const BASE_SEC = 1;
const CAP_SEC = 30;

function clientSidePolicies(): RetryPolicy[] {
  return [
    immediate(),
    fixedDelay(2),
    exponential(BASE_SEC, CAP_SEC),
    exponentialEqualJitter(BASE_SEC, CAP_SEC),
    exponentialFullJitter(BASE_SEC, CAP_SEC),
    decorrelatedJitter(BASE_SEC, CAP_SEC),
  ];
}

function fmt(value: number | null, digits = 1): string {
  return value === null ? "-" : value.toFixed(digits);
}

function printTable(header: string[], rows: string[][]): void {
  const widths = header.map((h, col) =>
    Math.max(h.length, ...rows.map((row) => (row[col] ?? "").length)),
  );
  const line = (cells: string[]): string =>
    cells.map((cell, col) => cell.padStart(widths[col] ?? 0)).join("  ");
  console.log(line(header));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) console.log(line(row));
}

function metricsRow(m: ScenarioMetrics): string[] {
  return [
    m.policyName,
    `${(m.successRate * 100).toFixed(1)}%`,
    String(m.totalAttempts),
    fmt(m.p50CompletionSec),
    fmt(m.p95CompletionSec),
    fmt(m.makespanSec),
    String(m.peakArrivalsPerSec),
    String(m.maxRetryCollision),
    m.capacityUtilization === null ? "-" : `${(m.capacityUtilization * 100).toFixed(0)}%`,
  ];
}

const METRICS_HEADER = [
  "policy",
  "success",
  "attempts",
  "p50 (s)",
  "p95 (s)",
  "makespan (s)",
  "peak arr/s",
  "collision",
  "util",
];

function runAndPrint(title: string, note: string, scenario: Scenario, policies: RetryPolicy[]): void {
  console.log(`\n=== ${title} ===`);
  console.log(note);
  console.log(
    `clients=${scenario.clients} spread=${scenario.startSpreadSec}s ` +
      `rate=${scenario.server.ratePerSec}/s burst=${scenario.server.burst} ` +
      `maxAttempts=${scenario.maxAttempts} seed=${scenario.seed}\n`,
  );
  printTable(
    METRICS_HEADER,
    policies.map((policy) => metricsRow(runScenario(scenario, policy).metrics)),
  );
}

function deadServiceReport(scenario: Scenario, policies: RetryPolicy[]): void {
  console.log(`\n=== scenario 3: dead service — load added while it is down ===`);
  console.log(
    "The server has zero capacity for the whole run; every client eventually gives up.\n" +
      "What differs is how hard the dying dependency gets hammered on the way there.",
  );
  console.log(
    `clients=${scenario.clients} rate=0/s maxAttempts=${scenario.maxAttempts} seed=${scenario.seed}\n`,
  );
  const rows = policies.map((policy) => {
    const { metrics, server, results } = runScenario(scenario, policy);
    const lastGiveUp = Math.max(...results.map((r) => r.finishTimeSec));
    return [
      policy.name,
      String(metrics.totalAttempts),
      String(server.arrivalsBetween(0, 5)),
      String(metrics.peakArrivalsPerSec),
      lastGiveUp.toFixed(1),
    ];
  });
  printTable(
    ["policy", "attempts", "arrivals in first 5s", "peak arr/s", "last give-up (s)"],
    rows,
  );
}

function main(): void {
  console.log("retry policies under simulated failures (virtual clock, deterministic)");

  const herd: Scenario = {
    name: "cold-start herd",
    clients: 500,
    startSpreadSec: 0,
    maxAttempts: 10,
    server: { ratePerSec: 50, burst: 50 },
    seed: 1,
  };
  runAndPrint(
    "scenario 1: cold-start thundering herd",
    "500 clients wake at t=0 against a 50 req/s bucket (burst 50). Ideal makespan is ~9s.",
    herd,
    clientSidePolicies(),
  );

  const outage: Scenario = {
    name: "outage recovery",
    clients: 200,
    startSpreadSec: 5,
    maxAttempts: 10,
    server: { ratePerSec: 40, burst: 40, outageUntilSec: 10 },
    seed: 2,
  };
  runAndPrint(
    "scenario 2: outage recovery with Retry-After",
    "200 clients arrive over 5s; the server 503s until t=10s, then recovers at 40 req/s.",
    outage,
    [
      retryAfterExact(),
      retryAfterJitter(BASE_SEC, CAP_SEC),
      exponential(BASE_SEC, CAP_SEC),
      exponentialFullJitter(BASE_SEC, CAP_SEC),
    ],
  );

  const dead: Scenario = {
    name: "dead service",
    clients: 100,
    startSpreadSec: 0,
    maxAttempts: 10,
    server: { ratePerSec: 0, burst: 0 },
    seed: 3,
  };
  deadServiceReport(dead, clientSidePolicies());

  console.log(
    "\nNote: retry-after-exact against a zero-capacity server would be told to wait forever;",
  );
  console.log("clients treat a non-finite Retry-After as a hard failure and give up immediately.");
}

main();
