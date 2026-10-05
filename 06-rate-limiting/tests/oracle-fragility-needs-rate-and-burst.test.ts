/**
 * The 100% oracle's 11 failures are not "the burst, not the rate". They need
 * both.
 *
 * The headroom sweep printed one attribution control (the same informed rate
 * behind a burst-5 bucket, which fails nothing) and read it as proof that the
 * average rate was never involved. But the sweep's own oracle-95 row holds the
 * burst at 20 and fails nothing too. Across the 2x2 of {100%, 95%} headroom by
 * {20, 5} pacing burst, exactly one cell fails: 100% behind burst 20. Either
 * knob alone removes every failure, so neither alone is the cause - the knife
 * edge is the conjunction, and the two "fixes, priced" are two ways of
 * breaking the same pair.
 *
 * The missing cell (95% behind burst 5) is the control that makes the
 * interaction readable instead of inferable, so the study prints it.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPacingStudy, type PacingStudyOptions } from "../src/pacing-study.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The headroom sweep's scenario, to the field: header-main.ts's DROP_BASE. */
const DROP_BASE: PacingStudyOptions = {
  clients: 20,
  requestsPerClient: 50,
  serverRatePerSec: 20,
  serverBurst: 20,
  rateSchedule: [{ atMs: 30_000, ratePerSec: 8 }],
  phaseBoundaryMs: 30_000,
  faultRate: 0.02,
  latencyMsMin: 20,
  latencyMsMax: 60,
  advertiseRetryAfter: true,
  advertiseRateHeaders: true,
  retry: {
    policy: { kind: "full-jitter", baseMs: 100, capMs: 10_000 },
    maxRetries: 8,
    respectRetryAfter: false,
  },
  seed: 42,
};

const cell = (headroom: number, burst: number) =>
  runPacingStudy(`oracle-${headroom * 100}-b${burst}`, { kind: "oracle", burst, headroom }, DROP_BASE);

function normalized(path: string): string {
  return readFileSync(path, "utf-8").split(/\s+/).join(" ");
}

describe("the 100% oracle's failures need the rate and the burst together", () => {
  it("fails only in the 100%-headroom, burst-20 cell", async () => {
    const [full20, full5, margin20, margin5] = await Promise.all([
      cell(1, 20),
      cell(1, 5),
      cell(0.95, 20),
      cell(0.95, 5),
    ]);
    // The published failing row.
    expect(full20.failed).toBe(11);
    expect(full20.count429).toBe(88);
    // Drop the burst to 5 and the same informed rate is clean: the control
    // the sweep already printed.
    expect(full5.failed).toBe(0);
    expect(full5.count429).toBe(0);
    // Keep the 20-wide burst and take 5% off the rate: also clean. This is
    // the row that refutes "never about the average rate".
    expect(margin20.failed).toBe(0);
    // And the missing cell closes the 2x2.
    expect(margin5.failed).toBe(0);
    expect(margin5.count429).toBe(0);
  });

  it("prices both fixes off the same failing cell", async () => {
    const [full20, full5, margin20] = await Promise.all([cell(1, 20), cell(1, 5), cell(0.95, 20)]);
    const burstCostMs = full5.makespanMs - full20.makespanMs;
    const marginCostMs = margin20.makespanMs - full20.makespanMs;
    // Shaping the burst costs 1.88s, 5% of margin costs 6.43s: both quoted
    // in the study, and the burst is the cheaper of the two.
    expect(burstCostMs / 1000).toBeCloseTo(1.88, 2);
    expect(marginCostMs / 1000).toBeCloseTo(6.43, 2);
    expect(burstCostMs).toBeLessThan(marginCostMs);
  });

  it("holds the readme to the interaction, not to a single cause", () => {
    const text = normalized(join(ROOT, "README.md"));
    expect(text).not.toContain("fragility was never about the average rate");
    expect(text).not.toContain("the knife edge lives in the 20-wide t=0 burst");
    expect(text).toContain("neither alone is the cause");
  });

  it("holds the repo index row to the interaction too", () => {
    const text = normalized(join(ROOT, "..", "README.md"));
    expect(text).not.toContain("it was never the 100% rate");
    expect(text).toContain("needs the 100% rate and the 20-wide t=0 burst together");
  });
});
