import { describe, expect, it } from "vitest";
import { runPacingStudy, type PacingStudyOptions } from "../src/pacing-study.js";

const RETRY = {
  policy: { kind: "full-jitter", baseMs: 50, capMs: 2000 },
  maxRetries: 6,
  respectRetryAfter: false,
} as const;

function makeOpts(overrides: Partial<PacingStudyOptions> = {}): PacingStudyOptions {
  return {
    clients: 4,
    requestsPerClient: 10,
    serverRatePerSec: 10,
    serverBurst: 4,
    faultRate: 0,
    latencyMsMin: 5,
    latencyMsMax: 15,
    advertiseRetryAfter: true,
    retry: RETRY,
    seed: 7,
    ...overrides,
  };
}

describe("runPacingStudy", () => {
  it("rejects malformed scenario shapes", async () => {
    await expect(runPacingStudy("x", { kind: "none" }, makeOpts({ clients: -1 }))).rejects.toThrow(/clients/);
    await expect(runPacingStudy("x", { kind: "none" }, makeOpts({ requestsPerClient: 2.5 }))).rejects.toThrow(
      /requestsPerClient/,
    );
    await expect(
      runPacingStudy(
        "x",
        { kind: "none" },
        makeOpts({ rateSchedule: [{ atMs: 100, ratePerSec: 5 }, { atMs: 100, ratePerSec: 3 }] }),
      ),
    ).rejects.toThrow(/ascending/);
    await expect(
      runPacingStudy("x", { kind: "none" }, makeOpts({ rateSchedule: [{ atMs: -1, ratePerSec: 5 }] })),
    ).rejects.toThrow(/atMs/);
  });

  it("handles zero clients and zero requests without dividing by anything", async () => {
    const empty = await runPacingStudy("empty", { kind: "none" }, makeOpts({ clients: 0 }));
    expect(empty.requests).toBe(0);
    expect(empty.succeeded).toBe(0);
    expect(empty.totalAttempts).toBe(0);
    expect(empty.makespanMs).toBe(0);
    expect(Number.isNaN(empty.okPerSec)).toBe(true);
    expect(Number.isNaN(empty.attemptsPerSuccess)).toBe(true);
  });

  it("accounts for every request under every pacer", async () => {
    const opts = makeOpts({ faultRate: 0.05, rateSchedule: [{ atMs: 2000, ratePerSec: 4 }], phaseBoundaryMs: 2000 });
    for (const [name, spec] of [
      ["none", { kind: "none" }],
      ["fixed", { kind: "fixed", ratePerSec: 10, burst: 4 }],
      ["oracle", { kind: "oracle", burst: 4 }],
      [
        "aimd",
        {
          kind: "aimd",
          opts: {
            initialRatePerSec: 2,
            minRatePerSec: 1,
            maxRatePerSec: 40,
            increasePerSec: 4,
            decreaseFactor: 0.5,
            holdOffMs: 500,
            burst: 2,
          },
        },
      ],
    ] as const) {
      const r = await runPacingStudy(name, spec, opts);
      expect(r.succeeded + r.failed).toBe(40);
      expect(r.totalAttempts).toBeGreaterThanOrEqual(40);
      expect(r.phase1Count429! + r.phase2Count429!).toBe(r.count429);
    }
  });

  it("is deterministic: same spec and seed, identical results", async () => {
    const opts = makeOpts({ faultRate: 0.05 });
    const spec = { kind: "fixed", ratePerSec: 12, burst: 2 } as const;
    const a = await runPacingStudy("a", spec, opts);
    const b = await runPacingStudy("b", spec, { ...opts });
    expect({ ...a, name: "" }).toEqual({ ...b, name: "" });
  });

  it("pacing below the budget eliminates 429s entirely", async () => {
    const r = await runPacingStudy("under", { kind: "fixed", ratePerSec: 5, burst: 1 }, makeOpts());
    expect(r.count429).toBe(0);
    expect(r.succeeded).toBe(40);
    // 40 requests through a 5/s pacer with burst 1 cannot beat the pacer rate.
    expect(r.okPerSec).toBeLessThanOrEqual(5.2);
  });

  it("pacing above the budget caps throughput at the server, not the client", async () => {
    const r = await runPacingStudy("over", { kind: "fixed", ratePerSec: 20, burst: 4 }, makeOpts());
    expect(r.count429).toBeGreaterThan(0);
    // Successes per second cannot exceed server rate plus the burst amortized.
    expect(r.okPerSec).toBeLessThanOrEqual(10 + (4 * 1000) / r.makespanMs);
  });

  it("the oracle takes zero 429s across a rate drop when there are no faults", async () => {
    const opts = makeOpts({
      clients: 4,
      requestsPerClient: 15,
      rateSchedule: [{ atMs: 3000, ratePerSec: 4 }],
      phaseBoundaryMs: 3000,
    });
    const oracle = await runPacingStudy("oracle", { kind: "oracle", burst: 4 }, opts);
    expect(oracle.count429).toBe(0);
    expect(oracle.succeeded).toBe(60);
    // The drop is real: phase 2 runs measurably slower than phase 1.
    expect(oracle.phase2OkPerSec!).toBeLessThan(oracle.phase1OkPerSec!);
    expect(oracle.phase2OkPerSec!).toBeLessThanOrEqual(4.5);
  });

  it("the rate trace does not change the run it samples, at any interval", async () => {
    // Every published adaptive row is measured with traceIntervalMs set. If the
    // sampler perturbs the run, those attempt and 429 counts are artifacts of
    // how often the instrument reads the rate.
    const base = makeOpts({
      clients: 4,
      requestsPerClient: 25,
      faultRate: 0.05,
      rateSchedule: [{ atMs: 3000, ratePerSec: 3 }],
      phaseBoundaryMs: 3000,
    });
    const specs = [
      [
        "aimd",
        {
          kind: "aimd",
          opts: {
            initialRatePerSec: 2,
            minRatePerSec: 1,
            maxRatePerSec: 40,
            increasePerSec: 2,
            decreaseFactor: 0.6,
            holdOffMs: 500,
            burst: 2,
          },
        },
      ],
      [
        "hdr-remaining",
        {
          kind: "header",
          opts: {
            mode: "remaining-only",
            initialRatePerSec: 2,
            minRatePerSec: 1,
            maxRatePerSec: 40,
            headroom: 1,
            burst: 2,
          },
        },
      ],
    ] as const;
    for (const [name, spec] of specs) {
      const opts = spec.kind === "header" ? { ...base, advertiseRateHeaders: true } : base;
      const untraced = await runPacingStudy(name, spec, opts);
      expect(untraced.rateTrace).toBeUndefined();
      for (const traceIntervalMs of [2000, 500, 50]) {
        const traced = await runPacingStudy(name, spec, { ...opts, traceIntervalMs });
        expect(traced.rateTrace!.length).toBeGreaterThan(1);
        expect({
          interval: traceIntervalMs,
          makespanMs: traced.makespanMs,
          totalAttempts: traced.totalAttempts,
          count429: traced.count429,
          phase2Count429: traced.phase2Count429,
          succeeded: traced.succeeded,
        }).toEqual({
          interval: traceIntervalMs,
          makespanMs: untraced.makespanMs,
          totalAttempts: untraced.totalAttempts,
          count429: untraced.count429,
          phase2Count429: untraced.phase2Count429,
          succeeded: untraced.succeeded,
        });
      }
    }
  });

  it("aimd converges instead of storming: fewer 429s than a stale fixed rate after a drop", async () => {
    const opts = makeOpts({
      clients: 4,
      requestsPerClient: 25,
      rateSchedule: [{ atMs: 3000, ratePerSec: 3 }],
      phaseBoundaryMs: 3000,
      traceIntervalMs: 1000,
    });
    const stale = await runPacingStudy("stale", { kind: "fixed", ratePerSec: 10, burst: 4 }, opts);
    const aimd = await runPacingStudy(
      "aimd",
      {
        kind: "aimd",
        opts: {
          initialRatePerSec: 2,
          minRatePerSec: 1,
          maxRatePerSec: 40,
          increasePerSec: 2,
          decreaseFactor: 0.6,
          holdOffMs: 500,
          burst: 2,
        },
      },
      opts,
    );
    expect(aimd.cuts!).toBeGreaterThan(0);
    expect(aimd.phase2Count429!).toBeLessThan(stale.phase2Count429!);
    expect(aimd.rateTrace!.length).toBeGreaterThan(3);
    // Late in the run the controller must sit near the 3/s budget, not at 10/s.
    const lastRate = aimd.rateTrace![aimd.rateTrace!.length - 1]!.ratePerSec;
    expect(lastRate).toBeLessThan(6);
    expect(lastRate).toBeGreaterThanOrEqual(1);
  });
});
