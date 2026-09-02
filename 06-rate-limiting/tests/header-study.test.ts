import { describe, expect, it } from "vitest";
import { runPacingStudy, type PacerSpec, type PacingStudyOptions } from "../src/pacing-study.js";
import type { HeaderPacerOptions } from "../src/header-pacer.js";

const RETRY = {
  policy: { kind: "full-jitter", baseMs: 50, capMs: 2000 },
  maxRetries: 6,
  respectRetryAfter: false,
} as const;

function makeOpts(overrides: Partial<PacingStudyOptions> = {}): PacingStudyOptions {
  return {
    clients: 4,
    requestsPerClient: 25,
    serverRatePerSec: 10,
    serverBurst: 4,
    faultRate: 0,
    latencyMsMin: 5,
    latencyMsMax: 15,
    advertiseRetryAfter: true,
    advertiseRateHeaders: true,
    retry: RETRY,
    seed: 7,
    ...overrides,
  };
}

function headerSpec(mode: HeaderPacerOptions["mode"], headroom = 1): PacerSpec {
  return {
    kind: "header",
    opts: {
      mode,
      initialRatePerSec: 2,
      minRatePerSec: 1,
      maxRatePerSec: 40,
      headroom,
      burst: 2,
      minWindowMs: 500,
      ewmaAlpha: 0.5,
      probeIncreasePerSec: 2,
      capSlackTokens: 3,
    },
  };
}

const AIMD: PacerSpec = {
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
};

describe("header-informed pacing studies", () => {
  it("refuses a header pacer against a server that sends no headers", async () => {
    await expect(
      runPacingStudy("x", headerSpec("trust-limit"), makeOpts({ advertiseRateHeaders: false })),
    ).rejects.toThrow(/advertiseRateHeaders/);
  });

  it("validates oracle headroom", async () => {
    await expect(
      runPacingStudy("x", { kind: "oracle", burst: 4, headroom: 1.5 }, makeOpts()),
    ).rejects.toThrow(/headroom/);
    await expect(
      runPacingStudy("x", { kind: "oracle", burst: 4, headroom: 0 }, makeOpts()),
    ).rejects.toThrow(/headroom/);
  });

  it("a discounted oracle trades throughput for distance from the limit", async () => {
    const full = await runPacingStudy("o100", { kind: "oracle", burst: 4 }, makeOpts());
    const half = await runPacingStudy("o50", { kind: "oracle", burst: 4, headroom: 0.5 }, makeOpts());
    expect(half.count429).toBe(0);
    expect(half.succeeded).toBe(100);
    expect(half.makespanMs).toBeGreaterThan(full.makespanMs);
    // Paced at 5 req/s the run cannot beat that rate by more than the burst.
    expect(half.okPerSec).toBeLessThanOrEqual(5 + (4 * 1000) / half.makespanMs);
  });

  it("trust-limit converges to a dropped budget without taking a single 429", async () => {
    const opts = makeOpts({
      rateSchedule: [{ atMs: 3000, ratePerSec: 3 }],
      phaseBoundaryMs: 3000,
      traceIntervalMs: 1000,
    });
    const r = await runPacingStudy("hdr", headerSpec("trust-limit"), opts);
    expect(r.succeeded).toBe(100);
    expect(r.count429).toBe(0);
    expect(r.headerObservations).toBeGreaterThan(0);
    // The pacer follows the advertised limit: after the drop the trace must
    // sit on the new 3 req/s budget, not the old 10.
    const lastRate = r.rateTrace!.at(-1)!.ratePerSec;
    expect(lastRate).toBe(3);
  });

  it("remaining-only converges onto a dropped budget from refill arithmetic alone", async () => {
    const opts = makeOpts({
      requestsPerClient: 40,
      rateSchedule: [{ atMs: 4000, ratePerSec: 3 }],
      phaseBoundaryMs: 4000,
      traceIntervalMs: 1000,
    });
    const r = await runPacingStudy("est", headerSpec("remaining-only"), opts);
    expect(r.succeeded).toBe(160);
    expect(r.estimateUpdates!).toBeGreaterThan(0);
    // Late in the run the estimate must track the 3 req/s budget, well below
    // the pre-drop 10 and above the 1 req/s floor.
    const lastRate = r.rateTrace!.at(-1)!.ratePerSec;
    expect(lastRate).toBeGreaterThan(1.5);
    expect(lastRate).toBeLessThan(6);
  });

  it("remaining-only discovers a raised budget through the censored regime by probing", async () => {
    // The server burst must exceed capSlackTokens or the cap can never be
    // observed (remaining is snapshotted after a take), and a cap that is
    // never seen is a cap the probe cannot use.
    const opts = makeOpts({
      requestsPerClient: 40,
      serverRatePerSec: 3,
      serverBurst: 10,
      rateSchedule: [{ atMs: 8000, ratePerSec: 12 }],
      phaseBoundaryMs: 8000,
      traceIntervalMs: 1000,
    });
    const r = await runPacingStudy("est", headerSpec("remaining-only"), opts);
    // Probing against a full start bucket overshoots the 3 req/s truth and
    // burns a few requests out; near-full success is the honest expectation.
    expect(r.succeeded).toBeGreaterThanOrEqual(150);
    expect(r.probeUpdates!).toBeGreaterThan(0);
    // A raise never sends a 429; only the full-bucket probe can find it.
    const lastRate = r.rateTrace!.at(-1)!.ratePerSec;
    expect(lastRate).toBeGreaterThan(6);
  });

  it("headers beat 429-only feedback on the drop scenario where it counts", async () => {
    const opts = makeOpts({
      requestsPerClient: 40,
      faultRate: 0.02,
      rateSchedule: [{ atMs: 4000, ratePerSec: 3 }],
      phaseBoundaryMs: 4000,
    });
    const aimd = await runPacingStudy("aimd", AIMD, opts);
    const hdr = await runPacingStudy("hdr", headerSpec("trust-limit"), opts);
    expect(hdr.makespanMs).toBeLessThan(aimd.makespanMs);
    expect(hdr.count429).toBeLessThan(aimd.count429);
  });

  it("is deterministic for header pacers: same seed, identical results", async () => {
    const opts = makeOpts({ faultRate: 0.05 });
    const a = await runPacingStudy("a", headerSpec("remaining-only"), opts);
    const b = await runPacingStudy("b", headerSpec("remaining-only"), { ...opts });
    expect({ ...a, name: "" }).toEqual({ ...b, name: "" });
  });

  it("keeps existing pacers untouched by the header flag: oracle rows match", async () => {
    const on = await runPacingStudy("on", { kind: "oracle", burst: 4 }, makeOpts());
    const off = await runPacingStudy("off", { kind: "oracle", burst: 4 }, makeOpts({ advertiseRateHeaders: false }));
    // The oracle never reads headers; enabling them only adds bucket reads,
    // which must not change admission behavior.
    expect(on.succeeded).toBe(off.succeeded);
    expect(on.count429).toBe(off.count429);
    expect(on.makespanMs).toBe(off.makespanMs);
  });
});
