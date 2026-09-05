/**
 * The breaker extension closes experiment 1 by claiming first attempts are
 * most of the load the client offers, which is what makes a gate in front of
 * the wire beat a budget that can only deny retries. Nothing measured that
 * share, so this pins it: `summarize` reports it, the entry point prints it,
 * and the readme quotes what the entry point prints.
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

/** Experiment 1 of storm-breaker-main, reproduced field for field. */
const PULSE_API: Partial<ApiOptions> = {
  baseLatencyMs: 100,
  perItemLatencyMs: 0,
  latencyJitter: 0.1,
  maxConcurrent: 4,
  slowdown: { startMs: 20_000, endMs: 35_000, factor: 5 },
};
const JITTER = { kind: "full-jitter", baseMs: 500, capMs: 8000 } as const;
const NO_BACKOFF = { kind: "fixed", delayMs: 0 } as const;
const BUDGET10 = { ratio: 0.1, cap: 10 } as const;
const BREAKER = { failureThreshold: 5, openMs: 5000 };

const DIP_POLICIES: StormPolicy[] = [
  { name: "no-retry", maxRetries: 0, backoff: NO_BACKOFF },
  { name: "jitter-x4", maxRetries: 4, backoff: JITTER },
  { name: "jitter+budget10", maxRetries: 4, backoff: JITTER, budget: BUDGET10 },
  { name: "no-retry+brk", maxRetries: 0, backoff: NO_BACKOFF, breaker: BREAKER },
  { name: "jitter-x4+brk", maxRetries: 4, backoff: JITTER, breaker: BREAKER },
  { name: "jitter+bgt10+brk", maxRetries: 4, backoff: JITTER, budget: BUDGET10, breaker: BREAKER },
];

const pct1 = (v: number) => `${v.toFixed(1)}%`;

const results = new Map<string, StormResult>();
const summaries = new Map<string, StormSummary>();

beforeAll(async () => {
  for (const policy of DIP_POLICIES) {
    const result = await runStorm({
      seed: 42,
      arrivalGapMs: 40,
      arrivalWindowMs: 90_000,
      timeoutMs: 1000,
      api: PULSE_API,
      policy,
    });
    results.set(policy.name, result);
    summaries.set(policy.name, summarize(result));
  }
}, 120_000);

describe("first attempts as a share of the load the client offers", () => {
  it("counts the tasks that reached the wire at least once", () => {
    for (const policy of DIP_POLICIES) {
      const result = results.get(policy.name)!;
      const summary = summaries.get(policy.name)!;
      const reachedTheWire = result.records.filter((r) => r.attempts >= 1).length;
      expect(summary.firstAttempts).toBe(reachedTheWire);
      expect(summary.firstAttemptPct).toBeCloseTo(
        (reachedTheWire / summary.attemptsStarted) * 100,
        10,
      );
    }
  });

  it("is almost the whole flood a budgeted client offers", () => {
    const budgeted = summaries.get("jitter+budget10")!;
    expect(pct1(budgeted.firstAttemptPct)).toBe("95.8%");
    // the other 4.2 points are every retry the budget could possibly deny
    const retries = budgeted.attemptsStarted - budgeted.firstAttempts;
    expect(pct1((retries / budgeted.attemptsStarted) * 100)).toBe("4.2%");
  });

  it("inverts once the retries are uncapped", () => {
    expect(pct1(summaries.get("jitter-x4")!.firstAttemptPct)).toBe("24.4%");
  });

  it("is 100% behind the gate: not one retry reaches the wire", () => {
    for (const name of ["no-retry+brk", "jitter-x4+brk", "jitter+bgt10+brk"]) {
      const summary = summaries.get(name)!;
      expect(summary.firstAttempts).toBe(summary.attemptsStarted);
      expect(pct1(summary.firstAttemptPct)).toBe("100.0%");
    }
  });

  it("is nowhere near 80% for any policy in the dip grid", () => {
    // the retired claim, restated as the invariant that refutes it
    for (const policy of DIP_POLICIES) {
      const share = summaries.get(policy.name)!.firstAttemptPct;
      expect(share < 70 || share > 90).toBe(true);
    }
  });
});

describe("the entry point and the readme", () => {
  let stdout = "";

  beforeAll(async () => {
    ({ stdout } = await run("npx", ["tsx", "src/storm-breaker-main.ts"], {
      cwd: projectRoot,
      maxBuffer: 32 * 1024 * 1024,
    }));
  }, 120_000);

  it("prints a first-attempt column carrying the measured share", () => {
    const experiment1 = stdout.split("== experiment 2")[0]!;
    const lines = experiment1.split("\n");
    const header = lines.find((l) => l.includes("policy") && l.includes("amp"))!;
    expect(header).toContain("1st att");
    for (const policy of DIP_POLICIES) {
      const row = lines.find((l) => l.trim().startsWith(`${policy.name} `))!;
      expect(row).toBeDefined();
      expect(row.split(/\s+/)).toContain(pct1(summaries.get(policy.name)!.firstAttemptPct));
    }
  });

  it("quotes the printed table character for character", () => {
    const readme = readFileSync(resolve(projectRoot, "README.md"), "utf8");
    const block = readme
      .split("### 1. the same 15s dip, budget vs breaker vs both")[1]!
      .split("```")[1]!;
    const printed = new Set(stdout.split("\n").map((l) => l.trimEnd()));
    for (const line of block.split("\n")) {
      if (line.trim() === "") continue;
      expect(printed.has(line.trimEnd())).toBe(true);
    }
    expect(block).toContain("1st att");
  });
});

describe("the readme prose", () => {
  const readme = readFileSync(resolve(projectRoot, "README.md"), "utf8");
  // the fixes section quotes the sentence it retired, so it is exempt
  const liveProse = readme.split("\n## fixes")[0]!;
  const flat = liveProse.replace(/\s+/g, " ");

  it("no longer claims first attempts are 80% of the flood", () => {
    expect(flat).not.toContain("first attempts are 80% of the flood");
  });

  it("carries the measured shares instead", () => {
    expect(flat).toContain("95.8%");
    expect(flat).toContain("24.4%");
  });
});
