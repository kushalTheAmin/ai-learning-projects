import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "../src/breaker.js";
import { requestWithBreaker } from "../src/breaker-retry.js";
import { VirtualClock } from "../src/clock.js";
import type { RetryOptions } from "../src/retry.js";
import type { ApiResponse } from "../src/server.js";
import { createRng } from "../../05-token-streaming/src/rng.js";

/** Scripted endpoint: pops one response per call, then always succeeds. */
function scripted(responses: ApiResponse[]): { send: () => Promise<ApiResponse>; calls: () => number } {
  let calls = 0;
  return {
    send: () => {
      calls++;
      return Promise.resolve(responses.shift() ?? { status: 200 });
    },
    calls: () => calls,
  };
}

const FIXED_ZERO: RetryOptions = {
  policy: { kind: "fixed", delayMs: 0 },
  maxRetries: 8,
  respectRetryAfter: false,
};

const ALWAYS = (res: ApiResponse): boolean => res.status !== 200;
const ONLY_503 = (res: ApiResponse): boolean => res.status === 503;

describe("requestWithBreaker", () => {
  it("rejects a negative maxRetries", async () => {
    const clock = new VirtualClock();
    const breaker = new CircuitBreaker(clock, { failureThreshold: 3, openMs: 100 });
    const { send } = scripted([]);
    const bad = { ...FIXED_ZERO, maxRetries: -1 };
    await expect(
      requestWithBreaker(send, clock, createRng(1), bad, breaker, "fail-fast", ALWAYS),
    ).rejects.toThrow(/maxRetries/);
  });

  it("passes a clean success through untouched", async () => {
    const clock = new VirtualClock();
    const breaker = new CircuitBreaker(clock, { failureThreshold: 3, openMs: 100 });
    const { send, calls } = scripted([]);
    const outcome = await clock.runUntil(
      requestWithBreaker(send, clock, createRng(1), FIXED_ZERO, breaker, "fail-fast", ALWAYS),
    );
    expect(outcome).toMatchObject({ ok: true, wireAttempts: 1, fastFailed: false, finalStatus: 200 });
    expect(calls()).toBe(1);
    expect(breaker.state()).toBe("closed");
  });

  it("fail-fast ends the request that trips the breaker after its backoff sleep", async () => {
    const clock = new VirtualClock();
    const breaker = new CircuitBreaker(clock, { failureThreshold: 3, openMs: 60_000 });
    const { send, calls } = scripted([{ status: 503 }, { status: 503 }, { status: 503 }]);
    const outcome = await clock.runUntil(
      requestWithBreaker(send, clock, createRng(1), FIXED_ZERO, breaker, "fail-fast", ALWAYS),
    );
    // 3 wire attempts trip it; the 4th acquisition meets the open gate.
    expect(outcome).toMatchObject({ ok: false, wireAttempts: 3, fastFailed: true, finalStatus: "breaker-open" });
    expect(calls()).toBe(3);
    expect(breaker.trips).toBe(1);
  });

  it("fail-fast rejects an already-open breaker with zero wire attempts", async () => {
    const clock = new VirtualClock();
    const breaker = new CircuitBreaker(clock, { failureThreshold: 1, openMs: 60_000 });
    const first = scripted([{ status: 503 }, { status: 503 }]);
    await clock.runUntil(
      requestWithBreaker(first.send, clock, createRng(1), FIXED_ZERO, breaker, "fail-fast", ALWAYS),
    );
    const second = scripted([]);
    const before = clock.now();
    const outcome = await clock.runUntil(
      requestWithBreaker(second.send, clock, createRng(1), FIXED_ZERO, breaker, "fail-fast", ALWAYS),
    );
    expect(outcome).toMatchObject({ ok: false, wireAttempts: 0, fastFailed: true, finalStatus: "breaker-open" });
    expect(outcome.endMs - outcome.startMs).toBe(0);
    expect(clock.now()).toBe(before);
    expect(second.calls()).toBe(0);
  });

  it("wait mode sleeps to the probe window and succeeds through the probe", async () => {
    const clock = new VirtualClock();
    const breaker = new CircuitBreaker(clock, { failureThreshold: 2, openMs: 500 });
    const { send, calls } = scripted([{ status: 503 }, { status: 503 }]);
    const outcome = await clock.runUntil(
      requestWithBreaker(send, clock, createRng(1), FIXED_ZERO, breaker, "wait", ALWAYS),
    );
    // Attempts at t=0 trip it; the request waits out the 500ms cooldown and
    // its probe (the third attempt) succeeds.
    expect(outcome).toMatchObject({ ok: true, wireAttempts: 3, fastFailed: false, finalStatus: 200 });
    expect(outcome.endMs).toBe(500);
    expect(calls()).toBe(3);
    expect(breaker.state()).toBe("closed");
    expect(breaker.probes).toBe(1);
  });

  it("wait mode still gives up when probes exhaust the retry budget", async () => {
    const clock = new VirtualClock();
    const breaker = new CircuitBreaker(clock, { failureThreshold: 2, openMs: 500 });
    const responses = Array.from({ length: 10 }, () => ({ status: 503 as const }));
    const { send, calls } = scripted(responses);
    const opts: RetryOptions = { ...FIXED_ZERO, maxRetries: 4 };
    const outcome = await clock.runUntil(
      requestWithBreaker(send, clock, createRng(1), opts, breaker, "wait", ALWAYS),
    );
    // 2 attempts trip it, then 3 probes at 500ms cadence burn the rest of the
    // budget: 5 wire attempts total, done at t=1500.
    expect(outcome).toMatchObject({ ok: false, wireAttempts: 5, fastFailed: false, finalStatus: 503 });
    expect(outcome.endMs).toBe(1500);
    expect(calls()).toBe(5);
  });

  it("a failure the predicate does not count settles as breaker success", async () => {
    const clock = new VirtualClock();
    const breaker = new CircuitBreaker(clock, { failureThreshold: 2, openMs: 60_000 });
    const { send, calls } = scripted([
      { status: 503 },
      { status: 429 }, // resets the streak under ONLY_503
      { status: 503 },
      { status: 429 },
      { status: 503 },
    ]);
    const outcome = await clock.runUntil(
      requestWithBreaker(send, clock, createRng(1), FIXED_ZERO, breaker, "fail-fast", ONLY_503),
    );
    expect(outcome).toMatchObject({ ok: true, wireAttempts: 6, finalStatus: 200 });
    expect(calls()).toBe(6);
    expect(breaker.trips).toBe(0);
  });

  it("counts the retry budget in wire attempts and reports the final status", async () => {
    const clock = new VirtualClock();
    const breaker = new CircuitBreaker(clock, { failureThreshold: 10, openMs: 100 });
    const { send, calls } = scripted([{ status: 429 }, { status: 429 }, { status: 503 }]);
    const opts: RetryOptions = { ...FIXED_ZERO, maxRetries: 2 };
    const outcome = await clock.runUntil(
      requestWithBreaker(send, clock, createRng(1), opts, breaker, "fail-fast", ALWAYS),
    );
    expect(outcome).toMatchObject({ ok: false, wireAttempts: 3, fastFailed: false, finalStatus: 503 });
    expect(calls()).toBe(3);
  });

  it("respects Retry-After exactly like the plain loop", async () => {
    const clock = new VirtualClock();
    const breaker = new CircuitBreaker(clock, { failureThreshold: 10, openMs: 100 });
    const { send } = scripted([{ status: 429, retryAfterMs: 700 }]);
    const opts: RetryOptions = { ...FIXED_ZERO, respectRetryAfter: true };
    const outcome = await clock.runUntil(
      requestWithBreaker(send, clock, createRng(1), opts, breaker, "fail-fast", ALWAYS),
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.endMs).toBe(700);
  });

  it("a breaker shared across sequential requests remembers the trip", async () => {
    const clock = new VirtualClock();
    const breaker = new CircuitBreaker(clock, { failureThreshold: 3, openMs: 60_000 });
    const dead = (): Promise<ApiResponse> => Promise.resolve({ status: 503 });
    const first = await clock.runUntil(
      requestWithBreaker(dead, clock, createRng(1), FIXED_ZERO, breaker, "fail-fast", ALWAYS),
    );
    const second = await clock.runUntil(
      requestWithBreaker(dead, clock, createRng(1), FIXED_ZERO, breaker, "fail-fast", ALWAYS),
    );
    expect(first.wireAttempts).toBe(3);
    expect(second.wireAttempts).toBe(0);
    expect(second.fastFailed).toBe(true);
  });

  it("policy none makes exactly one attempt even with the breaker closed", async () => {
    const clock = new VirtualClock();
    const breaker = new CircuitBreaker(clock, { failureThreshold: 10, openMs: 100 });
    const { send, calls } = scripted([{ status: 429 }]);
    const opts: RetryOptions = { policy: { kind: "none" }, maxRetries: 0, respectRetryAfter: false };
    const outcome = await clock.runUntil(
      requestWithBreaker(send, clock, createRng(1), opts, breaker, "fail-fast", ALWAYS),
    );
    expect(outcome).toMatchObject({ ok: false, wireAttempts: 1, finalStatus: 429 });
    expect(calls()).toBe(1);
  });
});
