/**
 * The retry budget's contract, stated three times in this project: the
 * balance is "earned per first attempt" and the ratio "caps the whole client
 * population's retry volume at `ratio` of offered load". A task the breaker
 * sheds at the gate offers nothing to the wire, so it must credit nothing.
 *
 * These tests pin the ledger: granted retries stay inside
 * `cap + ratio x firstAttempts`, a gate-shed task earns no token, and the
 * breaker extension's budgeted row prints what that accounting produces.
 * Breakerless runs are the control — every task there reaches the wire, so
 * the two readings coincide and the storm and cancellation tables cannot
 * move.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { runStorm, summarize, type StormConfig, type TaskRecord } from "../src/storm.js";
import type { ApiOptions } from "../src/api.js";

const run = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PULSE_API: Partial<ApiOptions> = {
  baseLatencyMs: 100,
  perItemLatencyMs: 0,
  latencyJitter: 0.1,
  maxConcurrent: 4,
  slowdown: { startMs: 20_000, endMs: 35_000, factor: 5 },
};
const JITTER = { kind: "full-jitter", baseMs: 500, capMs: 8000 } as const;
const BUDGET10 = { ratio: 0.1, cap: 10 } as const;
const BREAKER = { failureThreshold: 5, openMs: 5000 };

/**
 * A retry the budget granted: every loop round past a task's first cost one
 * token, whether that round reached the wire or died at the gate. A round
 * the budget refused is counted by `retriesDenied` instead.
 */
function grantedRetries(records: readonly TaskRecord[]): number {
  let granted = 0;
  for (const record of records) {
    granted +=
      record.fastFailed && record.attempts >= 1
        ? record.attempts
        : Math.max(0, record.attempts - 1);
  }
  return granted;
}

/**
 * A small run built to make the gap loud: a breaker on a hard-failing
 * service sheds most of the arrivals, so earning per arrival credits tokens
 * no first attempt paid for.
 */
const SHED_HEAVY: StormConfig = {
  seed: 42,
  arrivalGapMs: 100,
  arrivalWindowMs: 5000,
  timeoutMs: 1000,
  flakeRate: 1,
  api: { baseLatencyMs: 100, perItemLatencyMs: 0, latencyJitter: 0, maxConcurrent: 4 },
  policy: {
    name: "shed-heavy",
    maxRetries: 1,
    backoff: { kind: "fixed", delayMs: 0 },
    budget: { ratio: 0.1, cap: 1 },
    breaker: { failureThreshold: 2, openMs: 1000 },
  },
};

describe("the budget earns on the wire, not on arrival", () => {
  it("keeps granted retries inside cap + ratio x first attempts", async () => {
    const result = await runStorm(SHED_HEAVY);
    const s = summarize(result);
    const { ratio, cap } = SHED_HEAVY.policy.budget!;
    // 50 arrivals, 43 of them shed before any wire attempt, so the ceiling
    // the budget promises is 1 + 0.1 x 7 = 1.7 retries, not 1 + 0.1 x 50.
    expect(s.tasks).toBe(50);
    expect(s.firstAttempts).toBe(7);
    expect(result.records.filter((r) => r.attempts === 0).length).toBe(43);
    expect(grantedRetries(result.records)).toBeLessThanOrEqual(cap + ratio * s.firstAttempts);
  });

  it("credits nothing for a task shed at the gate", async () => {
    const result = await runStorm(SHED_HEAVY);
    const s = summarize(result);
    // every round past the first resolves as granted or denied, and the
    // supply here funds exactly one of the 7 rounds that asked
    expect(grantedRetries(result.records)).toBe(1);
    expect(s.retriesDenied).toBe(6);
    expect(result.records.filter((r) => r.budgetDenied).length).toBe(6);
    // the wire traffic is the same either way: only the accounting moved
    expect(s.attemptsStarted).toBe(8);
    expect(s.fastFailedTasks).toBe(43);
  });

  it("leaves a breakerless run identical, because every task reaches the wire", async () => {
    const result = await runStorm({
      seed: 42,
      arrivalGapMs: 40,
      arrivalWindowMs: 90_000,
      timeoutMs: 1000,
      api: PULSE_API,
      policy: { name: "jitter+budget10", maxRetries: 4, backoff: JITTER, budget: BUDGET10 },
    });
    const s = summarize(result);
    expect(s.firstAttempts).toBe(s.tasks);
    expect(result.records.filter((r) => r.attempts === 0).length).toBe(0);
    // the storm and cancellation tables' budgeted row, unchanged
    expect(`${s.successPct.toFixed(1)}%`).toBe("60.1%");
    expect(s.amplification.toFixed(2)).toBe("1.04");
    expect(s.retriesDenied).toBe(897);
  });

  it("prints the budgeted breaker row against first attempts", async () => {
    const result = await runStorm({
      seed: 42,
      arrivalGapMs: 40,
      arrivalWindowMs: 90_000,
      timeoutMs: 1000,
      api: PULSE_API,
      policy: {
        name: "jitter+bgt10+brk",
        maxRetries: 4,
        backoff: JITTER,
        budget: BUDGET10,
        breaker: BREAKER,
      },
    });
    const s = summarize(result);
    expect(s.retriesDenied).toBe(44);
    expect(`${s.fastFailPct.toFixed(1)}%`).toBe("12.8%");
    // the headline columns the row is read for do not move
    expect(`${s.successPct.toFixed(1)}%`).toBe("85.2%");
    expect(s.amplification.toFixed(2)).toBe("0.88");
    expect(`${s.firstAttemptPct.toFixed(1)}%`).toBe("100.0%");
    expect(`${s.wastedPct.toFixed(1)}%`).toBe("2.9%");
  });
}, 120_000);

describe("the entry point and the readme", () => {
  let stdout = "";

  beforeAll(async () => {
    ({ stdout } = await run("npx", ["tsx", "src/storm-breaker-main.ts"], {
      cwd: projectRoot,
      maxBuffer: 32 * 1024 * 1024,
    }));
  }, 120_000);

  it("prints the budgeted breaker row with 44 denials", () => {
    const row = stdout
      .split("\n")
      .find((l) => l.trim().startsWith("jitter+bgt10+brk "))!;
    expect(row).toBeDefined();
    const cells = row.trim().split(/\s+/);
    expect(cells).toContain("12.8%");
    expect(cells).toContain("44");
  });

  it("quotes that row character for character", () => {
    const readme = readFileSync(resolve(projectRoot, "README.md"), "utf8");
    const block = readme
      .split("### 1. the same 15s dip, budget vs breaker vs both")[1]!
      .split("```")[1]!;
    const printed = new Set(stdout.split("\n").map((l) => l.trimEnd()));
    const row = block.split("\n").find((l) => l.trim().startsWith("jitter+bgt10+brk "))!;
    expect(row).toBeDefined();
    expect(printed.has(row.trimEnd())).toBe(true);
  });
});

describe("the readme prose", () => {
  const readme = readFileSync(resolve(projectRoot, "README.md"), "utf8");
  // the fixes section quotes the retired number, so it is exempt
  const liveProse = readme.split("\n## fixes")[0]!;
  const flat = liveProse.replace(/\s+/g, " ");

  it("no longer reads the budgeted breaker row as 34 denials", () => {
    expect(flat).not.toContain("34 denials against 897");
  });

  it("carries the measured count instead", () => {
    expect(flat).toContain("44 denials against 897");
  });
});
