/**
 * Entry point for the cancellation-propagation study. Same virtual clock,
 * same seeded streams, same dip and load grids as the storm study; the one
 * variable is what the client's timeout does. Abandon mode hangs up and
 * leaves the attempt in the server's FIFO (the storm study's model). Cancel
 * mode aborts the attempt's call, which dequeues it if it is still waiting
 * for a slot; an attempt already in service completes as an orphan either
 * way. The question: how much of the metastable storm survives when only
 * in-service work is unkillable?
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

const MODES = [
  { name: "abandon", cancelOnTimeout: false },
  { name: "cancel", cancelOnTimeout: true },
] as const;

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
    `cancellation propagation: arrivals every ${ARRIVAL_GAP_MS}ms (${(1000 / ARRIVAL_GAP_MS).toFixed(1)}/s) ` +
      `for ${seconds(ARRIVAL_WINDOW_MS)}, server ${PULSE_API.maxConcurrent} slots x ` +
      `${PULSE_API.baseLatencyMs}ms (capacity ~40/s), client timeout ${TIMEOUT_MS}ms (seed ${DEFAULT_SEED})`,
  );
  console.log(
    `modes: abandon = hang up, orphan stays in the FIFO and is served to nobody; ` +
      `cancel = abort dequeues a still-queued attempt, in-service work completes anyway`,
  );
  console.log(
    `dip: server ${DIP_FACTOR}x slower in [${seconds(DIP_START_MS)}, ${seconds(DIP_END_MS)}), ` +
      `capacity ~8/s under 25/s of arrivals; recovery lag = last failed arrival after dip end`,
  );

  console.log(`\n== experiment 1: the same 15s dip, abandon vs cancel per policy ==`);
  const dipRows: string[][] = [];
  const timelines = new Map<string, string>();
  for (const policy of POLICIES) {
    for (const mode of MODES) {
      const result = await runStorm({
        seed: DEFAULT_SEED,
        arrivalGapMs: ARRIVAL_GAP_MS,
        arrivalWindowMs: ARRIVAL_WINDOW_MS,
        timeoutMs: TIMEOUT_MS,
        api: PULSE_API,
        policy,
        cancelOnTimeout: mode.cancelOnTimeout,
      });
      const s = summarize(result);
      const lag = recoveryLagMs(result, DIP_END_MS, ARRIVAL_WINDOW_MS);
      dipRows.push([
        policy.name,
        mode.name,
        pct(s.successPct),
        f2(s.amplification),
        pct(s.wastedPct),
        pct(s.cancelledPct),
        String(s.maxQueueDepth),
        ms(s.p95LatencyMs),
        lag === undefined ? "NEVER" : seconds(lag),
        seconds(s.drainedAtMs),
        s.usdPer1kDone === undefined ? "-" : `$${s.usdPer1kDone.toFixed(2)}`,
      ]);
      if (policy.name === "immediate-x4") {
        const bins = timeline(result.records, TIMELINE_BIN_MS, ARRIVAL_WINDOW_MS);
        timelines.set(
          `${policy.name} / ${mode.name}`,
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
  }
  console.log(
    table(
      [
        "policy",
        "mode",
        "ok",
        "amp",
        "wasted",
        "cancelled",
        "queue max",
        "p95",
        "recovery",
        "drained",
        "$/1k ok",
      ],
      dipRows,
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
      for (const mode of MODES) {
        const result = await runStorm({
          seed: DEFAULT_SEED,
          arrivalGapMs: gapMs,
          arrivalWindowMs: ARRIVAL_WINDOW_MS,
          timeoutMs: TIMEOUT_MS,
          api: { ...PULSE_API, slowdown: undefined },
          policy,
          cancelOnTimeout: mode.cancelOnTimeout,
        });
        const s = summarize(result);
        sweepRows.push([
          `${((1000 / gapMs / 40) * 100).toFixed(0)}%`,
          policy.name,
          mode.name,
          pct(s.successPct),
          f2(s.amplification),
          pct(s.wastedPct),
          pct(s.cancelledPct),
          String(s.maxQueueDepth),
          ms(s.p95LatencyMs),
          seconds(s.drainedAtMs),
        ]);
      }
    }
  }
  console.log(
    table(
      ["load", "policy", "mode", "ok", "amp", "wasted", "cancelled", "queue max", "p95", "drained"],
      sweepRows,
    ),
  );
}

await main();
