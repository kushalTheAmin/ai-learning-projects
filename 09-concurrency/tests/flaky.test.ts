import { describe, expect, it } from "vitest";
import { VirtualClock } from "../../06-rate-limiting/src/clock.js";
import { ApiError, SimulatedApi, makeItems } from "../src/api.js";
import type { WorkItem } from "../src/api.js";
import { runFlakyRecovery } from "../src/flaky.js";
import { ISOLATION_STRATEGIES } from "../src/isolate.js";
import { makeFlakyItems } from "../src/flaky-study.js";

const flatRng = () => 0.5;
/** Every draw fires: 0 < rate for any positive rate. */
const alwaysFire = () => 0;
/** No draw fires below rate 1: 0.999999 >= any rate < 1. */
const neverFire = () => 0.999999;

function setup(flakeRng?: () => number) {
  const clock = new VirtualClock();
  const api = new SimulatedApi(clock, flatRng, {}, flakeRng);
  return { clock, api };
}

function flakyBatch(count: number, flakyIds: readonly number[], rate: number): WorkItem[] {
  return makeFlakyItems(count, flakyIds, rate);
}

describe("SimulatedApi flake handling", () => {
  it("rejects a call whose flaky item fires, charging input tokens like poison", async () => {
    const { clock, api } = setup(alwaysFire);
    await expect(clock.runUntil(api.call(flakyBatch(4, [2], 0.5)))).rejects.toMatchObject({
      name: "ApiError",
      kind: "validation",
    });
    const stats = api.snapshot();
    expect(stats.failedCalls).toBe(1);
    expect(stats.inputTokens).toBe(400 + 4 * 60);
    expect(stats.outputTokens).toBe(0);
  });

  it("completes a call whose flaky items all miss their draw", async () => {
    const { clock, api } = setup(neverFire);
    const results = await clock.runUntil(api.call(flakyBatch(4, [1, 3], 0.9)));
    expect(results).toHaveLength(4);
    expect(api.snapshot().failedCalls).toBe(0);
  });

  it("treats flakeRate 1 as a guaranteed failure under any rng", async () => {
    const { clock, api } = setup(neverFire);
    await expect(clock.runUntil(api.call(flakyBatch(2, [0], 1)))).rejects.toBeInstanceOf(ApiError);
  });

  it("throws a plain error when flaky items arrive without a flake rng", async () => {
    const { clock, api } = setup(undefined);
    await expect(clock.runUntil(api.call(flakyBatch(2, [1], 0.5)))).rejects.toThrow(
      /no flake rng/,
    );
  });

  it("accepts flakeRate 0 items without a flake rng", async () => {
    const { clock, api } = setup(undefined);
    const results = await clock.runUntil(api.call(flakyBatch(3, [], 0)));
    expect(results).toHaveLength(3);
  });

  it("still rejects when a poisoned item rides alongside lucky flaky items", async () => {
    const clock = new VirtualClock();
    const api = new SimulatedApi(clock, flatRng, {}, neverFire);
    const items: WorkItem[] = [
      { id: 0, poisoned: true },
      { id: 1, poisoned: false, flakeRate: 0.5 },
    ];
    await expect(clock.runUntil(api.call(items))).rejects.toMatchObject({ kind: "validation" });
  });

  it("draws once per flaky item in the call, whatever the outcomes", async () => {
    let draws = 0;
    const countingNeverFire = () => {
      draws++;
      return 0.999999;
    };
    const { clock, api } = setup(countingNeverFire);
    await clock.runUntil(api.call(flakyBatch(6, [0, 2, 5], 0.5)));
    expect(draws).toBe(3);

    draws = 0;
    const countingAlwaysFire = () => {
      draws++;
      return 0;
    };
    const { clock: clock2, api: api2 } = setup(countingAlwaysFire);
    await expect(clock2.runUntil(api2.call(flakyBatch(6, [0, 2, 5], 0.5)))).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(draws).toBe(3);
  });

  it("leaves the latency stream untouched when flake draws happen", async () => {
    // Two apis on the same latency seed. One's first call carries flaky
    // items (drawing from the dedicated rng), the other's is clean. Their
    // second, identical clean calls must then take exactly as long.
    const { createRng } = await import("../../05-token-streaming/src/rng.js");
    const durations: number[] = [];
    for (const firstCallFlaky of [true, false]) {
      const clock = new VirtualClock();
      const api = new SimulatedApi(clock, createRng(7), {}, alwaysFire);
      const first = firstCallFlaky ? flakyBatch(4, [1, 2], 0.8) : makeItems(4);
      await clock.runUntil(api.call(first).catch(() => undefined));
      const startedAt = clock.now();
      await clock.runUntil(api.call(makeItems(4)));
      durations.push(clock.now() - startedAt);
    }
    expect(durations[0]).toBe(durations[1]);
  });
});

describe("runFlakyRecovery", () => {
  const budgetOf = (maxRetries: number) => maxRetries + 1;

  it("uses one call and completes everything when nothing is flaky", async () => {
    for (const strategy of ISOLATION_STRATEGIES) {
      const { clock, api } = setup(neverFire);
      const outcome = await clock.runUntil(
        runFlakyRecovery(api, clock, makeItems(8), strategy),
      );
      expect(outcome.calls).toBe(1);
      expect(outcome.completed).toHaveLength(8);
      expect(outcome.givenUp).toEqual([]);
    }
  });

  it("returns a zero outcome on an empty item list", async () => {
    for (const strategy of ISOLATION_STRATEGIES) {
      const { clock, api } = setup(neverFire);
      const outcome = await clock.runUntil(runFlakyRecovery(api, clock, [], strategy));
      expect(outcome.calls).toBe(0);
      expect(outcome.completed).toEqual([]);
      expect(outcome.givenUp).toEqual([]);
      expect(outcome.elapsedMs).toBe(0);
    }
  });

  it("fail-all makes exactly one attempt against a certain failure", async () => {
    const { clock, api } = setup(alwaysFire);
    const outcome = await clock.runUntil(
      runFlakyRecovery(api, clock, flakyBatch(8, [3], 1), "fail-all"),
    );
    expect(outcome.calls).toBe(1);
    expect(outcome.completed).toHaveLength(0);
    expect(outcome.givenUp).toEqual([]);
  });

  it("retry-whole burns its whole budget against flakeRate 1 and completes nothing", async () => {
    const { clock, api } = setup(alwaysFire);
    const outcome = await clock.runUntil(
      runFlakyRecovery(api, clock, flakyBatch(8, [3], 1), "retry-whole", 2),
    );
    expect(outcome.calls).toBe(budgetOf(2));
    expect(outcome.completed).toHaveLength(0);
  });

  it("retry-whole recovers the entire batch the moment one resend passes", async () => {
    // First two draws fire, the third misses: whole call fails twice, then
    // the identical resend goes through with every item aboard.
    const draws = [0, 0, 0.99];
    const scripted = () => draws.shift() ?? 0.99;
    const { clock, api } = setup(scripted);
    const outcome = await clock.runUntil(
      runFlakyRecovery(api, clock, flakyBatch(8, [3], 0.5), "retry-whole", 3),
    );
    expect(outcome.calls).toBe(3);
    expect(outcome.completed).toHaveLength(8);
    expect(outcome.givenUp).toEqual([]);
  });

  it("one-by-one gives each item its own budget and pins the bad one", async () => {
    const { clock, api } = setup(alwaysFire);
    const outcome = await clock.runUntil(
      runFlakyRecovery(api, clock, flakyBatch(8, [3], 1), "one-by-one", 2),
    );
    // 1 whole + 7 healthy singletons + 3 attempts on the certain failure.
    expect(outcome.calls).toBe(1 + 7 + budgetOf(2));
    expect(outcome.completed).toHaveLength(7);
    expect(outcome.givenUp).toEqual([3]);
  });

  it("bisect retries a failing singleton on the same budget before giving up", async () => {
    const { clock, api } = setup(alwaysFire);
    const outcome = await clock.runUntil(
      runFlakyRecovery(api, clock, flakyBatch(8, [3], 1), "bisect", 2),
    );
    // [0..7] fail, [0..3] fail, [0,1] pass, [2,3] fail, [2] pass,
    // [3] three failing attempts, [4..7] pass.
    expect(outcome.calls).toBe(9);
    expect(outcome.completed).toHaveLength(7);
    expect(outcome.givenUp).toEqual([3]);
  });

  it("handles a single-item batch under every strategy", async () => {
    const expectedCalls = {
      "fail-all": 1,
      "retry-whole": budgetOf(2),
      "one-by-one": 1 + budgetOf(2),
      bisect: budgetOf(2),
    } as const;
    for (const strategy of ISOLATION_STRATEGIES) {
      const { clock, api } = setup(alwaysFire);
      const outcome = await clock.runUntil(
        runFlakyRecovery(api, clock, flakyBatch(1, [0], 1), strategy, 2),
      );
      expect(outcome.calls).toBe(expectedCalls[strategy]);
      expect(outcome.completed).toHaveLength(0);
    }
  });

  it("charges tokens for every resend, overhead included", async () => {
    const { clock, api } = setup(alwaysFire);
    const outcome = await clock.runUntil(
      runFlakyRecovery(api, clock, flakyBatch(8, [3], 1), "retry-whole", 1),
    );
    expect(outcome.inputTokens).toBe(2 * (400 + 8 * 60));
  });
});
