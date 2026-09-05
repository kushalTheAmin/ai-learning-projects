/**
 * The cancellation section explains the rescue with the composition of the
 * post-dip backlog, and nothing measured that composition. This pins it: the
 * api logs every call's queue entry and exit, `queueCompositionAt` reads the
 * FIFO's contents back at any instant, the entry point prints the split, and
 * the readme quotes what it prints.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { runStorm, queueCompositionAt, type StormPolicy, type StormResult } from "../src/storm.js";
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
const DIP_END_MS = 35_000;
const TIMEOUT_MS = 1000;
const NO_BACKOFF = { kind: "fixed", delayMs: 0 } as const;
const JITTER = { kind: "full-jitter", baseMs: 500, capMs: 8000 } as const;

const POLICIES: StormPolicy[] = [
  { name: "no-retry", maxRetries: 0, backoff: NO_BACKOFF },
  { name: "immediate-x4", maxRetries: 4, backoff: NO_BACKOFF },
  { name: "jitter-x4", maxRetries: 4, backoff: JITTER },
  { name: "jitter+budget10", maxRetries: 4, backoff: JITTER, budget: { ratio: 0.1, cap: 10 } },
];

const pct1 = (v: number) => `${v.toFixed(1)}%`;
const key = (policy: string, mode: string) => `${policy}/${mode}`;

const results = new Map<string, StormResult>();

beforeAll(async () => {
  for (const policy of POLICIES) {
    for (const cancelOnTimeout of [false, true]) {
      const result = await runStorm({
        seed: 42,
        arrivalGapMs: 40,
        arrivalWindowMs: 90_000,
        timeoutMs: TIMEOUT_MS,
        api: PULSE_API,
        policy,
        cancelOnTimeout,
      });
      results.set(key(policy.name, cancelOnTimeout ? "cancel" : "abandon"), result);
    }
  }
}, 180_000);

describe("the admission log", () => {
  it("logs every call exactly once, entry before exit", () => {
    for (const [name, result] of results) {
      const { admissions, calls, cancelledInQueue } = result.apiStats;
      expect(admissions.length, name).toBe(calls + cancelledInQueue);
      for (const a of admissions) {
        expect(a.leftQueueAtMs, name).toBeGreaterThanOrEqual(a.queuedAtMs);
      }
      expect(admissions.filter((a) => a.cancelled).length, name).toBe(cancelledInQueue);
    }
  });

  it("reconstructs a depth the semaphore's own high water agrees with", () => {
    // sweep every entry instant: the log's peak depth must equal maxQueueDepth
    for (const [name, result] of results) {
      let peak = 0;
      for (const at of result.apiStats.admissions.map((a) => a.queuedAtMs)) {
        let depth = 0;
        for (const a of result.apiStats.admissions) {
          if (a.queuedAtMs <= at && a.leftQueueAtMs > at) depth++;
        }
        peak = Math.max(peak, depth);
      }
      expect(peak, name).toBe(result.apiStats.maxQueueDepth);
    }
  });

  it("is empty before the first arrival and after the drain", () => {
    for (const [name, result] of results) {
      expect(queueCompositionAt(result, -1, TIMEOUT_MS).queued, name).toBe(0);
      expect(queueCompositionAt(result, result.drainedAtMs, TIMEOUT_MS).queued, name).toBe(0);
    }
  });
});

describe("the post-dip backlog in abandon mode", () => {
  it("is essentially all already dead, not two thirds", () => {
    const q = queueCompositionAt(results.get(key("no-retry", "abandon"))!, DIP_END_MS, TIMEOUT_MS);
    expect(q.queued).toBe(256);
    expect(q.timedOutAlready).toBe(231);
    expect(pct1(q.timedOutAlreadyPct)).toBe("90.2%");
    // the retired claim, restated as the invariant that refutes it
    expect(q.timedOutAlreadyPct).toBeGreaterThan(80);
  });

  it("is entirely dead by the time a slot reaches it", () => {
    const q = queueCompositionAt(results.get(key("no-retry", "abandon"))!, DIP_END_MS, TIMEOUT_MS);
    expect(q.clientGoneAtExit).toBe(q.queued);
    expect(pct1(q.clientGoneAtExitPct)).toBe("100.0%");
  });

  it("holds for every policy, not just no-retry", () => {
    for (const policy of POLICIES) {
      const q = queueCompositionAt(
        results.get(key(policy.name, "abandon"))!,
        DIP_END_MS,
        TIMEOUT_MS,
      );
      expect(q.timedOutAlreadyPct, policy.name).toBeGreaterThan(85);
      expect(q.clientGoneAtExitPct, policy.name).toBe(100);
    }
  });

  it("is 256 at the dip end and 259 only at the run's later peak", () => {
    // the sentence used to quote the queue max as the dip-end depth; they are
    // different instants, and the peak lands 240ms after the dip ends
    const result = results.get(key("no-retry", "abandon"))!;
    expect(result.apiStats.maxQueueDepth).toBe(259);
    expect(queueCompositionAt(result, DIP_END_MS, TIMEOUT_MS).queued).toBe(256);
    expect(queueCompositionAt(result, 35_240, TIMEOUT_MS).queued).toBe(259);
  });
});

describe("the post-dip backlog in cancel mode", () => {
  it("cannot hold anything that has already timed out", () => {
    for (const policy of POLICIES) {
      const q = queueCompositionAt(
        results.get(key(policy.name, "cancel"))!,
        DIP_END_MS,
        TIMEOUT_MS,
      );
      expect(q.timedOutAlready, policy.name).toBe(0);
    }
  });

  it("is 25 deep and nearly all live where abandon is 256 deep and all dead", () => {
    const q = queueCompositionAt(results.get(key("no-retry", "cancel"))!, DIP_END_MS, TIMEOUT_MS);
    expect(q.queued).toBe(25);
    expect(q.clientGoneAtExit).toBe(3);
    expect(pct1(q.clientGoneAtExitPct)).toBe("12.0%");
  });
});

describe("the entry point and the readme", () => {
  let stdout = "";

  beforeAll(async () => {
    ({ stdout } = await run("npx", ["tsx", "src/cancel-main.ts"], {
      cwd: projectRoot,
      maxBuffer: 32 * 1024 * 1024,
    }));
  }, 180_000);

  it("prints the queue composition at the dip end", () => {
    expect(stdout).toContain("the admission queue at the instant the dip ends");
    const block = stdout.split("the admission queue at the instant the dip ends")[1]!.split("\n== ")[0]!;
    const row = block.split("\n").find((l) => l.trim().startsWith("no-retry  abandon"))!;
    expect(row).toBeDefined();
    const cells = row.trim().split(/\s+/);
    expect(cells).toEqual(["no-retry", "abandon", "256", "231", "90.2%", "256", "100.0%"]);
  });

  it("quotes the printed block character for character", () => {
    const readme = readFileSync(resolve(projectRoot, "README.md"), "utf8");
    const section = readme.split("### 1. the same 15s dip, abandon vs cancel")[1]!;
    const block = section.split("```")[3]!;
    expect(block).toContain("gone at exit");
    const printed = new Set(stdout.split("\n").map((l) => l.trimEnd()));
    for (const line of block.split("\n")) {
      if (line.trim() === "") continue;
      expect(printed.has(line.trimEnd()), line).toBe(true);
    }
  });
});

describe("the readme prose", () => {
  const readme = readFileSync(resolve(projectRoot, "README.md"), "utf8");
  // the fixes section quotes the sentence it retired, so it is exempt
  const liveProse = readme.split("\n## fixes")[0]!;
  // whitespace-normalized so a line wrap cannot make these pass
  const flat = liveProse.replace(/\s+/g, " ");

  it("no longer calls the backlog two thirds ghosts", () => {
    expect(flat).not.toContain("two thirds of them ghosts");
    expect(flat).not.toContain("the dip leaves 259 requests in the FIFO");
  });

  it("carries the measured composition instead", () => {
    expect(flat).toContain("256 requests in the FIFO");
    expect(flat).toContain("90.2%");
  });

  it("still quotes the sentence it retired, in the fixes section", () => {
    expect(readme).toContain("two thirds of them ghosts");
  });
});
