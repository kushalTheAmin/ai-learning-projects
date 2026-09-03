/**
 * Entry point for the breaker-vs-budget study. Same virtual clock, same
 * seeded streams, same dip / cliff / flake grids as the storm study; the one
 * new piece is 06's circuit breaker imported unchanged and shared by every
 * task as a fail-fast gate in front of the wire. The retry budget caps retry
 * VOLUME (a fraction of offered load, spent one token per retry); the
 * breaker acts on error-rate EVIDENCE (consecutive counted failures) and
 * sheds first attempts too, which the budget never touches. The questions:
 * which one un-sticks the metastable storm, which recovers faster once the
 * dip ends, and whether the half-open probe traffic reopens the storm.
 */
import type { ApiOptions } from "./api.js";
import { runStorm, summarize, recoveryLagMs, timeline, type StormPolicy } from "./storm.js";
import { DEFAULT_SEED } from "./experiment.js";
import type { BreakerOptions } from "../../06-rate-limiting/src/breaker.js";

const DIP_START_MS = 20_000;
const DIP_END_MS = 35_000;
const DIP_FACTOR = 5;

const PULSE_API: Partial<ApiOptions> = {
  baseLatencyMs: 100,
  perItemLatencyMs: 0,
  latencyJitter: 0.1,
  maxConcurrent: 4,
  slowdown: { startMs: DIP_START_MS, endMs: DIP_END_MS, factor: DIP_FACTOR },
};

const ARRIVAL_GAP_MS = 40;
const ARRIVAL_WINDOW_MS = 90_000;
const TIMEOUT_MS = 1000;
const TIMELINE_BIN_MS = 10_000;

const JITTER = { kind: "full-jitter", baseMs: 500, capMs: 8000 } as const;
const NO_BACKOFF = { kind: "fixed", delayMs: 0 } as const;
const BUDGET10 = { ratio: 0.1, cap: 10 } as const;
const BREAKER: BreakerOptions = { failureThreshold: 5, openMs: 5000 };

const DIP_POLICIES: StormPolicy[] = [
  { name: "no-retry", maxRetries: 0, backoff: NO_BACKOFF },
  { name: "jitter-x4", maxRetries: 4, backoff: JITTER },
  { name: "jitter+budget10", maxRetries: 4, backoff: JITTER, budget: BUDGET10 },
  { name: "no-retry+brk", maxRetries: 0, backoff: NO_BACKOFF, breaker: BREAKER },
  { name: "jitter-x4+brk", maxRetries: 4, backoff: JITTER, breaker: BREAKER },
  {
    name: "jitter+bgt10+brk",
    maxRetries: 4,
    backoff: JITTER,
    budget: BUDGET10,
    breaker: BREAKER,
  },
];

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padStart(widths[i]!)).join("  ");
  return [line(headers), ...rows.map(line)].join("\n");
}

const pct = (v: number) => `${v.toFixed(1)}%`;
const f2 = (v: number) => v.toFixed(2);
const ms = (v: number | undefined) => (v === undefined ? "-" : `${v.toFixed(0)}ms`);
const seconds = (v: number) => `${(v / 1000).toFixed(1)}s`;

async function main(): Promise<void> {
  console.log(
    `breaker vs budget: arrivals every ${ARRIVAL_GAP_MS}ms (${(1000 / ARRIVAL_GAP_MS).toFixed(1)}/s) ` +
      `for ${seconds(ARRIVAL_WINDOW_MS)}, server ${PULSE_API.maxConcurrent} slots x ` +
      `${PULSE_API.baseLatencyMs}ms (capacity ~40/s), client timeout ${TIMEOUT_MS}ms, ` +
      `abandonment does not cancel (seed ${DEFAULT_SEED})`,
  );
  console.log(
    `breaker: 06's CircuitBreaker shared across all tasks, fail-fast, ` +
      `threshold ${BREAKER.failureThreshold} consecutive counted failures, ` +
      `cooldown ${seconds(BREAKER.openMs)}, one half-open probe; a timeout counts as ` +
      `a failure at the timeout instant and orphan results never settle the gate`,
  );
  console.log(
    `dip: server ${DIP_FACTOR}x slower in [${seconds(DIP_START_MS)}, ${seconds(DIP_END_MS)}), ` +
      `capacity ~8/s under 25/s of arrivals; recovery lag = last failed arrival after dip end`,
  );

  console.log(`\n== experiment 1: the same 15s dip, budget vs breaker vs both ==`);
  const dipRows: string[][] = [];
  let breakerTimeline = "";
  for (const policy of DIP_POLICIES) {
    const result = await runStorm({
      seed: DEFAULT_SEED,
      arrivalGapMs: ARRIVAL_GAP_MS,
      arrivalWindowMs: ARRIVAL_WINDOW_MS,
      timeoutMs: TIMEOUT_MS,
      api: PULSE_API,
      policy,
    });
    const s = summarize(result);
    const lag = recoveryLagMs(result, DIP_END_MS, ARRIVAL_WINDOW_MS);
    const b = s.breakerStats;
    dipRows.push([
      policy.name,
      pct(s.successPct),
      f2(s.amplification),
      pct(s.wastedPct),
      pct(s.fastFailPct),
      b === undefined ? "-" : String(b.trips),
      b === undefined ? "-" : `${b.probeFailures}/${b.probes}`,
      String(s.retriesDenied),
      lag === undefined ? "NEVER" : seconds(lag),
      seconds(s.drainedAtMs),
      s.usdPer1kDone === undefined ? "-" : `$${s.usdPer1kDone.toFixed(2)}`,
    ]);
    if (policy.name === "jitter-x4+brk") {
      const bins = timeline(result.records, TIMELINE_BIN_MS, ARRIVAL_WINDOW_MS);
      breakerTimeline = table(
        ["arrival bin", "tasks", "ok", "attempts/task", "mean ok latency"],
        bins.map((bin) => [
          `${seconds(bin.startMs)}-${seconds(bin.startMs + TIMELINE_BIN_MS)}`,
          String(bin.arrivals),
          pct(bin.succeededPct),
          f2(bin.meanAttempts),
          ms(bin.meanLatencyMs),
        ]),
      );
    }
  }
  console.log(
    table(
      [
        "policy",
        "ok",
        "amp",
        "wasted",
        "fastfail",
        "trips",
        "probefail",
        "denied",
        "recovery",
        "drained",
        "$/1k ok",
      ],
      dipRows,
    ),
  );

  console.log(`\n== timeline: jitter-x4+brk (10s arrival bins) ==`);
  console.log(breakerTimeline);

  console.log(
    `\n== experiment 2: cooldown sweep on jitter-x4+brk, same dip ` +
      `(does the probe reopen the storm?) ==`,
  );
  const sweepRows: string[][] = [];
  for (const openMs of [1000, 2000, 5000, 15_000]) {
    const result = await runStorm({
      seed: DEFAULT_SEED,
      arrivalGapMs: ARRIVAL_GAP_MS,
      arrivalWindowMs: ARRIVAL_WINDOW_MS,
      timeoutMs: TIMEOUT_MS,
      api: PULSE_API,
      policy: {
        name: `brk-${openMs}`,
        maxRetries: 4,
        backoff: JITTER,
        breaker: { failureThreshold: BREAKER.failureThreshold, openMs },
      },
    });
    const s = summarize(result);
    const lag = recoveryLagMs(result, DIP_END_MS, ARRIVAL_WINDOW_MS);
    const b = s.breakerStats!;
    sweepRows.push([
      seconds(openMs),
      pct(s.successPct),
      f2(s.amplification),
      pct(s.wastedPct),
      pct(s.fastFailPct),
      String(b.trips),
      `${b.probeFailures}/${b.probes}`,
      lag === undefined ? "NEVER" : seconds(lag),
      seconds(s.drainedAtMs),
    ]);
  }
  console.log(
    table(
      ["cooldown", "ok", "amp", "wasted", "fastfail", "trips", "probefail", "recovery", "drained"],
      sweepRows,
    ),
  );

  console.log(`\n== experiment 3: no dip, sustained overload past the capacity cliff ==`);
  const cliffRows: string[][] = [];
  for (const gapMs of [24, 20]) {
    for (const policy of [DIP_POLICIES[0]!, DIP_POLICIES[3]!, DIP_POLICIES[4]!]) {
      const result = await runStorm({
        seed: DEFAULT_SEED,
        arrivalGapMs: gapMs,
        arrivalWindowMs: ARRIVAL_WINDOW_MS,
        timeoutMs: TIMEOUT_MS,
        api: { ...PULSE_API, slowdown: undefined },
        policy,
      });
      const s = summarize(result);
      const b = s.breakerStats;
      cliffRows.push([
        `${((1000 / gapMs / 40) * 100).toFixed(0)}%`,
        policy.name,
        pct(s.successPct),
        f2(s.amplification),
        pct(s.wastedPct),
        pct(s.fastFailPct),
        b === undefined ? "-" : String(b.trips),
        ms(s.p95LatencyMs),
        seconds(s.drainedAtMs),
      ]);
    }
  }
  console.log(
    table(
      ["load", "policy", "ok", "amp", "wasted", "fastfail", "trips", "p95", "drained"],
      cliffRows,
    ),
  );

  console.log(
    `\n== experiment 4: no dip, 20% per-attempt flake, load 63% ` +
      `(false trips on a healthy service) ==`,
  );
  const flakeRows: string[][] = [];
  const flakeBase: StormPolicy = { name: "jitter-x4", maxRetries: 4, backoff: JITTER };
  const flakeConfigs: StormPolicy[] = [
    flakeBase,
    ...[3, 5, 10].map((failureThreshold) => ({
      name: `jitter-x4+brk-t${failureThreshold}`,
      maxRetries: 4,
      backoff: JITTER,
      breaker: { failureThreshold, openMs: BREAKER.openMs },
    })),
  ];
  for (const policy of flakeConfigs) {
    const result = await runStorm({
      seed: DEFAULT_SEED,
      arrivalGapMs: ARRIVAL_GAP_MS,
      arrivalWindowMs: ARRIVAL_WINDOW_MS,
      timeoutMs: TIMEOUT_MS,
      flakeRate: 0.2,
      api: { ...PULSE_API, slowdown: undefined },
      policy,
    });
    const s = summarize(result);
    const b = s.breakerStats;
    flakeRows.push([
      policy.name,
      pct(s.successPct),
      f2(s.amplification),
      String(s.fastFailedTasks),
      b === undefined ? "-" : String(b.trips),
      b === undefined ? "-" : `${b.probeFailures}/${b.probes}`,
      ms(s.p95LatencyMs),
    ]);
  }
  console.log(
    table(["policy", "ok", "amp", "fastfail", "trips", "probefail", "p95"], flakeRows),
  );
}

await main();
