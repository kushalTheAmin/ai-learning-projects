/**
 * The cancellation section reads the ugly success tail as cancel mode's: "in
 * cancel mode ... successes now include multi-attempt slogs at 6.5-12s p95".
 * immediate-x4 is the zero-delay control sitting in the same table and it
 * prints 110ms against abandon's 109ms, so the range is three of the four x4
 * schedules and not the mode. This pins the decomposition: cancellation
 * decides that multi-attempt successes exist, the share decides whether p95
 * can see them, and the backoff schedule decides how slow they run.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { runStorm, summarize, type StormPolicy, type StormResult, type StormSummary } from "../src/storm.js";
import type { ApiOptions } from "../src/api.js";

const run = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Experiment 1 of cancel-main, reproduced field for field. */
const PULSE_API: Partial<ApiOptions> = {
  baseLatencyMs: 100,
  perItemLatencyMs: 0,
  latencyJitter: 0.1,
  maxConcurrent: 4,
  slowdown: { startMs: 20_000, endMs: 35_000, factor: 5 },
};
const TIMEOUT_MS = 1000;
const MAX_RETRIES = 4;

const POLICIES: StormPolicy[] = [
  { name: "no-retry", maxRetries: 0, backoff: { kind: "fixed", delayMs: 0 } },
  { name: "immediate-x4", maxRetries: MAX_RETRIES, backoff: { kind: "fixed", delayMs: 0 } },
  { name: "fixed-500-x4", maxRetries: MAX_RETRIES, backoff: { kind: "fixed", delayMs: 500 } },
  {
    name: "expo-x4",
    maxRetries: MAX_RETRIES,
    backoff: { kind: "exponential", baseMs: 500, capMs: 8000 },
  },
  {
    name: "jitter-x4",
    maxRetries: MAX_RETRIES,
    backoff: { kind: "full-jitter", baseMs: 500, capMs: 8000 },
  },
  {
    name: "jitter+budget10",
    maxRetries: MAX_RETRIES,
    backoff: { kind: "full-jitter", baseMs: 500, capMs: 8000 },
    budget: { ratio: 0.1, cap: 10 },
  },
];

/** The four unbudgeted x4 rows: the group the retired sentence described. */
const X4 = ["immediate-x4", "fixed-500-x4", "expo-x4", "jitter-x4"] as const;

const pct1 = (v: number) => `${v.toFixed(1)}%`;
const ms0 = (v: number | undefined) => (v === undefined ? "-" : `${v.toFixed(0)}ms`);
const key = (policy: string, mode: string) => `${policy}|${mode}`;

const results = new Map<string, StormResult>();
const summaries = new Map<string, StormSummary>();

beforeAll(async () => {
  for (const policy of POLICIES) {
    for (const mode of ["abandon", "cancel"] as const) {
      const result = await runStorm({
        seed: 42,
        arrivalGapMs: 40,
        arrivalWindowMs: 90_000,
        timeoutMs: TIMEOUT_MS,
        api: PULSE_API,
        policy,
        cancelOnTimeout: mode === "cancel",
      });
      results.set(key(policy.name, mode), result);
      summaries.set(key(policy.name, mode), summarize(result));
    }
  }
}, 240_000);

describe("the multi-attempt success measurement", () => {
  it("counts the successes that needed more than one attempt", () => {
    for (const policy of POLICIES) {
      for (const mode of ["abandon", "cancel"]) {
        const result = results.get(key(policy.name, mode))!;
        const summary = summaries.get(key(policy.name, mode))!;
        const slogs = result.records.filter((r) => r.ok && r.attempts > 1);
        expect(summary.multiAttemptOk).toBe(slogs.length);
        expect(summary.multiAttemptOkPct).toBeCloseTo(
          summary.succeeded === 0 ? 0 : (slogs.length / summary.succeeded) * 100,
          10,
        );
        if (slogs.length === 0) {
          expect(summary.p95MultiAttemptLatencyMs).toBeUndefined();
        } else {
          expect(summary.p95MultiAttemptLatencyMs).toBeGreaterThan(TIMEOUT_MS);
        }
      }
    }
  });

  it("is exactly zero on every x4 abandon row: the only successes are first attempts", () => {
    for (const name of X4) {
      const summary = summaries.get(key(name, "abandon"))!;
      expect(summary.multiAttemptOk).toBe(0);
      expect(ms0(summary.p95LatencyMs)).toBe("109ms");
    }
  });

  it("is nonzero on every x4 cancel row: cancellation creates them in all four", () => {
    for (const name of X4) {
      expect(summaries.get(key(name, "cancel"))!.multiAttemptOk).toBeGreaterThan(0);
    }
    expect(summaries.get(key("immediate-x4", "cancel"))!.multiAttemptOk).toBe(18);
    expect(summaries.get(key("fixed-500-x4", "cancel"))!.multiAttemptOk).toBe(32);
    expect(summaries.get(key("expo-x4", "cancel"))!.multiAttemptOk).toBe(120);
    expect(summaries.get(key("jitter-x4", "cancel"))!.multiAttemptOk).toBe(88);
  });
});

describe("the control the retired sentence skipped", () => {
  it("moves immediate-x4's p95 by one millisecond across the modes", () => {
    expect(ms0(summaries.get(key("immediate-x4", "abandon"))!.p95LatencyMs)).toBe("109ms");
    expect(ms0(summaries.get(key("immediate-x4", "cancel"))!.p95LatencyMs)).toBe("110ms");
  });

  it("holds immediate-x4's slogs under the 5% the 95th percentile can reach", () => {
    const summary = summaries.get(key("immediate-x4", "cancel"))!;
    expect(pct1(summary.multiAttemptOkPct)).toBe("3.4%");
    expect(summary.multiAttemptOkPct).toBeLessThan(5);
    // they exist, they are slow, and p95 cannot see them
    expect(ms0(summary.p95MultiAttemptLatencyMs)).toBe("4955ms");
  });

  it("shows p95 moving exactly where the share clears 5%", () => {
    for (const name of X4) {
      const summary = summaries.get(key(name, "cancel"))!;
      const p95MovedOffFirstAttempts = (summary.p95LatencyMs ?? 0) > TIMEOUT_MS;
      expect(p95MovedOffFirstAttempts).toBe(summary.multiAttemptOkPct >= 5);
    }
    expect(pct1(summaries.get(key("fixed-500-x4", "cancel"))!.multiAttemptOkPct)).toBe("5.9%");
    expect(pct1(summaries.get(key("expo-x4", "cancel"))!.multiAttemptOkPct)).toBe("19.1%");
    expect(pct1(summaries.get(key("jitter-x4", "cancel"))!.multiAttemptOkPct)).toBe("14.8%");
  });

  it("puts the slog ceiling on the backoff schedule, not the mode", () => {
    // five attempts means five timeouts plus the schedule's own cumulative delay
    const ceilings: Record<string, number> = {
      "immediate-x4": 5 * TIMEOUT_MS,
      "fixed-500-x4": 5 * TIMEOUT_MS + 4 * 500,
      "expo-x4": 5 * TIMEOUT_MS + (500 + 1000 + 2000 + 4000),
      "jitter-x4": 5 * TIMEOUT_MS + (500 + 1000 + 2000 + 4000),
    };
    for (const name of X4) {
      const slowest = Math.max(
        ...results
          .get(key(name, "cancel"))!
          .records.filter((r) => r.ok && r.attempts > 1)
          .map((r) => r.latencyMs!),
      );
      expect(slowest).toBeLessThanOrEqual(ceilings[name]!);
      expect(slowest).toBeGreaterThan(ceilings[name]! - 1.2 * TIMEOUT_MS);
    }
    // so the published 6.5-12s is fixed-500's 7.0s and expo's 12.5s, and
    // immediate-x4's own ceiling of 5.0s sits below the whole range
    expect(ceilings["immediate-x4"]).toBeLessThan(6500);
  });

  it("refutes a uniform 109ms for abandon mode too", () => {
    const budgeted = summaries.get(key("jitter+budget10", "abandon"))!;
    expect(budgeted.multiAttemptOk).toBe(4);
    expect(ms0(budgeted.p95LatencyMs)).toBe("257ms");
  });
});

describe("the entry point and the readme", () => {
  let stdout = "";

  beforeAll(async () => {
    ({ stdout } = await run("npx", ["tsx", "src/cancel-main.ts"], {
      cwd: projectRoot,
      maxBuffer: 32 * 1024 * 1024,
    }));
  }, 240_000);

  it("prints the share and the slog p95 as columns", () => {
    const experiment1 = stdout.split("== the admission queue")[0]!;
    const lines = experiment1.split("\n");
    const header = lines.find((l) => l.includes("policy") && l.includes("queue max"))!;
    expect(header).toContain("multi ok");
    expect(header).toContain("p95 multi");
    for (const policy of POLICIES) {
      for (const mode of ["abandon", "cancel"]) {
        const row = lines.find(
          (l) => l.trim().startsWith(`${policy.name} `) && l.includes(` ${mode} `),
        )!;
        expect(row).toBeDefined();
        const summary = summaries.get(key(policy.name, mode))!;
        const cells = row.split(/\s+/);
        expect(cells).toContain(pct1(summary.multiAttemptOkPct));
        expect(cells).toContain(ms0(summary.p95MultiAttemptLatencyMs));
      }
    }
  });

  it("quotes the printed table character for character", () => {
    const readme = readFileSync(resolve(projectRoot, "README.md"), "utf8");
    const block = readme
      .split("### 1. the same 15s dip, abandon vs cancel")[1]!
      .split("```")[1]!;
    const printed = new Set(stdout.split("\n").map((l) => l.trimEnd()));
    for (const line of block.split("\n")) {
      if (line.trim() === "") continue;
      expect(printed.has(line.trimEnd())).toBe(true);
    }
    expect(block).toContain("multi ok");
    expect(block).toContain("p95 multi");
  });
});

describe("the readme prose", () => {
  const readme = readFileSync(resolve(projectRoot, "README.md"), "utf8");
  // the fixes section quotes the sentence it retired, so it is exempt
  const liveProse = readme.split("\n## fixes")[0]!;
  const flat = liveProse.replace(/\s+/g, " ");

  it("no longer reads the 6.5-12s tail as cancel mode's", () => {
    expect(flat).not.toContain("include multi-attempt slogs at 6.5-12s p95");
    expect(flat).not.toContain("cancel mode's successes run to 12s p95");
  });

  it("names the control and what it prints", () => {
    expect(flat).toContain("immediate-x4");
    expect(flat).toContain("110ms against abandon's 109ms");
    expect(flat).toContain("3.4%");
  });

  it("puts the ceiling on the backoff schedule", () => {
    expect(flat).toContain("12.5s");
    expect(flat).toContain("5.0s");
  });

  it("keeps the retired sentence in the fixes section", () => {
    expect(readme).toContain("6.5-12s");
  });
});
