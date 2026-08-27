import { describe, expect, it } from "vitest";
import { VirtualClock } from "../src/clock.js";
import { requestWithRetry, type RetryOptions } from "../src/retry.js";
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

describe("requestWithRetry", () => {
  it("rejects a negative or fractional maxRetries", async () => {
    const clock = new VirtualClock();
    const { send } = scripted([]);
    const bad = { ...FIXED_ZERO, maxRetries: -1 };
    await expect(requestWithRetry(send, clock, createRng(1), bad)).rejects.toThrow(/maxRetries/);
  });

  it("returns after one attempt on immediate success", async () => {
    const clock = new VirtualClock();
    const { send, calls } = scripted([]);
    const outcome = await clock.runUntil(requestWithRetry(send, clock, createRng(1), FIXED_ZERO));
    expect(outcome).toMatchObject({ ok: true, attempts: 1, finalStatus: 200 });
    expect(calls()).toBe(1);
  });

  it("retries through 429s and 503s until success", async () => {
    const clock = new VirtualClock();
    const { send, calls } = scripted([{ status: 429 }, { status: 503 }, { status: 429 }]);
    const outcome = await clock.runUntil(requestWithRetry(send, clock, createRng(1), FIXED_ZERO));
    expect(outcome).toMatchObject({ ok: true, attempts: 4, finalStatus: 200 });
    expect(calls()).toBe(4);
  });

  it("stops after maxRetries and reports the final status", async () => {
    const clock = new VirtualClock();
    const { send, calls } = scripted([
      { status: 429 },
      { status: 429 },
      { status: 503 },
    ]);
    const opts: RetryOptions = { ...FIXED_ZERO, maxRetries: 2 };
    const outcome = await clock.runUntil(requestWithRetry(send, clock, createRng(1), opts));
    expect(outcome).toMatchObject({ ok: false, attempts: 3, finalStatus: 503 });
    expect(calls()).toBe(3);
  });

  it("makes exactly one attempt with policy none", async () => {
    const clock = new VirtualClock();
    const { send, calls } = scripted([{ status: 429 }]);
    const opts: RetryOptions = { policy: { kind: "none" }, maxRetries: 0, respectRetryAfter: false };
    const outcome = await clock.runUntil(requestWithRetry(send, clock, createRng(1), opts));
    expect(outcome).toMatchObject({ ok: false, attempts: 1, finalStatus: 429 });
    expect(calls()).toBe(1);
  });

  it("waits the exponential schedule between attempts", async () => {
    const clock = new VirtualClock();
    const { send } = scripted([{ status: 429 }, { status: 429 }, { status: 429 }]);
    const opts: RetryOptions = {
      policy: { kind: "exponential", baseMs: 100, capMs: 10_000 },
      maxRetries: 8,
      respectRetryAfter: false,
    };
    const outcome = await clock.runUntil(requestWithRetry(send, clock, createRng(1), opts));
    expect(outcome.ok).toBe(true);
    expect(outcome.endMs - outcome.startMs).toBe(100 + 200 + 400);
  });

  it("waits at least Retry-After when respecting it", async () => {
    const clock = new VirtualClock();
    const { send } = scripted([{ status: 429, retryAfterMs: 700 }]);
    const opts: RetryOptions = {
      policy: { kind: "fixed", delayMs: 100 },
      maxRetries: 8,
      respectRetryAfter: true,
    };
    const outcome = await clock.runUntil(requestWithRetry(send, clock, createRng(1), opts));
    expect(outcome.ok).toBe(true);
    expect(outcome.endMs - outcome.startMs).toBe(700);
  });

  it("ignores Retry-After when not respecting it", async () => {
    const clock = new VirtualClock();
    const { send } = scripted([{ status: 429, retryAfterMs: 700 }]);
    const outcome = await clock.runUntil(
      requestWithRetry(send, clock, createRng(1), {
        policy: { kind: "fixed", delayMs: 100 },
        maxRetries: 8,
        respectRetryAfter: false,
      }),
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.endMs - outcome.startMs).toBe(100);
  });
});
