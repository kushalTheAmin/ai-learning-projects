/**
 * Entry point for the timeout-retry storm study. Virtual time, seeded
 * streams: this output reproduces exactly run to run.
 *
 * Experiment 1: a fixed arrival stream at ~63% of server capacity, with a
 * 15s window in which the server runs 5x slower (capacity 8/s against 25/s
 * of arrivals). Every retry policy meets the identical dip; the question is
 * which ones let the system come back.
 *
 * Experiment 2: no dip, just offered load swept through 100% of capacity,
 * comparing no-retry against jittered exponential retries at the cliff.
 *
 * Experiment 3: healthy load, transient per-attempt faults instead of
 * overload: the regime retries were invented for, and the one that decides
 * how big a retry budget has to be.
 */
import type { ApiOptions } from "./api.js";
import { runStorm, summarize, recoveryLagMs, timeline, type StormPolicy } from "./storm.js";
import { DEFAULT_SEED } from "./experiment.js";

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

const POLICIES: StormPolicy[] = [
  { name: "no-retry", maxRetries: 0, backoff: { kind: "fixed", delayMs: 0 } },
  { name: "immediate-x4", maxRetries: 4, backoff: { kind: "fixed", delayMs: 0 } },
  { name: "fixed-500-x4", maxRetries: 4, backoff: { kind: "fixed", delayMs: 500 } },
  { name: "expo-x4", maxRetries: 4, backoff: { kind: "exponential", baseMs: 500, capMs: 8000 } },
  { name: "jitter-x4", maxRetries: 4, backoff: { kind: "full-jitter", baseMs: 500, capMs: 8000 } },
  {
    name: "jitter+budget10",
    maxRetries: 4,
    backoff: { kind: "full-jitter", baseMs: 500, capMs: 8000 },
    budget: { ratio: 0.1, cap: 10 },
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
    `timeout-retry storm: arrivals every ${ARRIVAL_GAP_MS}ms (${(1000 / ARRIVAL_GAP_MS).toFixed(1)}/s) ` +
      `for ${seconds(ARRIVAL_WINDOW_MS)}, server ${PULSE_API.maxConcurrent} slots x ` +
      `${PULSE_API.baseLatencyMs}ms (capacity ~40/s), client timeout ${TIMEOUT_MS}ms, ` +
      `abandonment does not cancel (seed ${DEFAULT_SEED})`,
  );
  console.log(
    `dip: server ${DIP_FACTOR}x slower in [${seconds(DIP_START_MS)}, ${seconds(DIP_END_MS)}), ` +
      `capacity ~8/s under 25/s of arrivals; recovery lag = last failed arrival after dip end`,
  );

  console.log(`\n== experiment 1: the same 15s dip under each retry policy ==`);
  const pulseRows: string[][] = [];
  const timelines = new Map<string, string>();
  for (const policy of POLICIES) {
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
    pulseRows.push([
      policy.name,
      pct(s.successPct),
      f2(s.amplification),
      pct(s.wastedPct),
      ms(s.p50LatencyMs),
      ms(s.p95LatencyMs),
      String(s.retriesDenied),
      lag === undefined ? "NEVER" : seconds(lag),
      seconds(s.drainedAtMs),
      s.usdPer1kDone === undefined ? "-" : `$${s.usdPer1kDone.toFixed(2)}`,
    ]);
    if (policy.name === "jitter-x4" || policy.name === "jitter+budget10") {
      const bins = timeline(result.records, TIMELINE_BIN_MS, ARRIVAL_WINDOW_MS);
      timelines.set(
        policy.name,
        table(
          ["arrival bin", "tasks", "ok", "attempts/task", "mean ok latency"],
          bins.map((b) => [
            `${seconds(b.startMs)}-${seconds(b.startMs + TIMELINE_BIN_MS)}`,
            String(b.arrivals),
            pct(b.succeededPct),
            f2(b.meanAttempts),
            ms(b.meanLatencyMs),
          ]),
        ),
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
        "p50",
        "p95",
        "denied",
        "recovery",
        "drained",
        "$/1k ok",
      ],
      pulseRows,
    ),
  );

  for (const [name, text] of timelines) {
    console.log(`\n== timeline: ${name} (10s arrival bins) ==`);
    console.log(text);
  }

  console.log(`\n== experiment 2: no dip, offered load through the capacity cliff ==`);
  const sweepRows: string[][] = [];
  for (const gapMs of [30, 25, 24, 20]) {
    for (const policy of [POLICIES[0]!, POLICIES[4]!]) {
      const result = await runStorm({
        seed: DEFAULT_SEED,
        arrivalGapMs: gapMs,
        arrivalWindowMs: ARRIVAL_WINDOW_MS,
        timeoutMs: TIMEOUT_MS,
        api: { ...PULSE_API, slowdown: undefined },
        policy,
      });
      const s = summarize(result);
      sweepRows.push([
        `${((1000 / gapMs / 40) * 100).toFixed(0)}%`,
        policy.name,
        pct(s.successPct),
        f2(s.amplification),
        pct(s.wastedPct),
        ms(s.p95LatencyMs),
        seconds(s.drainedAtMs),
      ]);
    }
  }
  console.log(
    table(["load", "policy", "ok", "amp", "wasted", "p95", "drained"], sweepRows),
  );

  console.log(`\n== experiment 3: no dip, per-attempt flake, load 63% ==`);
  const flakeRows: string[][] = [];
  for (const flakeRate of [0.05, 0.2]) {
    for (const policy of [POLICIES[0]!, POLICIES[4]!, POLICIES[5]!]) {
      const result = await runStorm({
        seed: DEFAULT_SEED,
        arrivalGapMs: ARRIVAL_GAP_MS,
        arrivalWindowMs: ARRIVAL_WINDOW_MS,
        timeoutMs: TIMEOUT_MS,
        flakeRate,
        api: { ...PULSE_API, slowdown: undefined },
        policy,
      });
      const s = summarize(result);
      flakeRows.push([
        pct(flakeRate * 100),
        policy.name,
        pct(s.successPct),
        f2(s.amplification),
        String(s.retriesDenied),
        ms(s.p95LatencyMs),
        s.usdPer1kDone === undefined ? "-" : `$${s.usdPer1kDone.toFixed(2)}`,
      ]);
    }
  }
  console.log(table(["flake", "policy", "ok", "amp", "denied", "p95", "$/1k ok"], flakeRows));
}

await main();
