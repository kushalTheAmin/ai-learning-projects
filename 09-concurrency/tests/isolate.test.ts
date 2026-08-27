import { describe, expect, it } from "vitest";
import { VirtualClock } from "../../06-rate-limiting/src/clock.js";
import { SimulatedApi, makeItems } from "../src/api.js";
import { ISOLATION_STRATEGIES, runWithIsolation } from "../src/isolate.js";

const flatRng = () => 0.5;

function setup() {
  const clock = new VirtualClock();
  const api = new SimulatedApi(clock, flatRng);
  return { clock, api };
}

describe("runWithIsolation", () => {
  it("uses a single call and loses nothing when no item is poisoned", async () => {
    for (const strategy of ISOLATION_STRATEGIES) {
      const { clock, api } = setup();
      const outcome = await clock.runUntil(runWithIsolation(api, clock, makeItems(8), strategy));
      expect(outcome.calls).toBe(1);
      expect(outcome.completed).toHaveLength(8);
      expect(outcome.lostHealthy).toBe(0);
      expect(outcome.poisonedIdentified).toEqual([]);
    }
  });

  it("fail-all drops every healthy item for one cheap call", async () => {
    const { clock, api } = setup();
    const outcome = await clock.runUntil(
      runWithIsolation(api, clock, makeItems(8, [3]), "fail-all"),
    );
    expect(outcome.calls).toBe(1);
    expect(outcome.completed).toHaveLength(0);
    expect(outcome.lostHealthy).toBe(7);
    expect(outcome.inputTokens).toBe(400 + 8 * 60);
  });

  it("retry-whole burns its retry budget against a deterministic rejection", async () => {
    const { clock, api } = setup();
    const outcome = await clock.runUntil(
      runWithIsolation(api, clock, makeItems(8, [3]), "retry-whole", 2),
    );
    expect(outcome.calls).toBe(3);
    expect(outcome.completed).toHaveLength(0);
    expect(outcome.lostHealthy).toBe(7);
    expect(outcome.inputTokens).toBe(3 * (400 + 8 * 60));
  });

  it("one-by-one saves every healthy item at one call per item", async () => {
    const { clock, api } = setup();
    const outcome = await clock.runUntil(
      runWithIsolation(api, clock, makeItems(8, [3]), "one-by-one"),
    );
    expect(outcome.calls).toBe(9);
    expect(outcome.completed).toHaveLength(7);
    expect(outcome.lostHealthy).toBe(0);
    expect(outcome.poisonedIdentified).toEqual([3]);
  });

  it("bisect finds one poisoned item in 1 + 2·log2(n) calls", async () => {
    const { clock, api } = setup();
    const outcome = await clock.runUntil(
      runWithIsolation(api, clock, makeItems(8, [3]), "bisect"),
    );
    expect(outcome.calls).toBe(7);
    expect(outcome.completed).toHaveLength(7);
    expect(outcome.lostHealthy).toBe(0);
    expect(outcome.poisonedIdentified).toEqual([3]);
  });

  it("bisect handles every item being poisoned", async () => {
    const { clock, api } = setup();
    const outcome = await clock.runUntil(
      runWithIsolation(api, clock, makeItems(2, [0, 1]), "bisect"),
    );
    expect(outcome.calls).toBe(3);
    expect(outcome.completed).toHaveLength(0);
    expect(outcome.lostHealthy).toBe(0);
    expect(outcome.poisonedIdentified.sort()).toEqual([0, 1]);
  });

  it("bisect on a single poisoned item identifies it in one call", async () => {
    const { clock, api } = setup();
    const outcome = await clock.runUntil(
      runWithIsolation(api, clock, makeItems(1, [0]), "bisect"),
    );
    expect(outcome.calls).toBe(1);
    expect(outcome.poisonedIdentified).toEqual([0]);
  });

  it("propagates non-validation errors instead of treating them as poison", async () => {
    const clock = new VirtualClock();
    const api = new SimulatedApi(clock, flatRng, { maxItemsPerCall: 4 });
    await expect(
      clock.runUntil(runWithIsolation(api, clock, makeItems(8, [3]), "bisect")),
    ).rejects.toMatchObject({ kind: "oversize" });
  });
});
