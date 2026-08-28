import { describe, expect, it } from "vitest";
import { createRng } from "../../05-token-streaming/src/rng.js";
import { INTENTS } from "../src/dataset.js";
import { applyTypo, DEFAULT_TRAFFIC, generateTraffic, type TrafficConfig } from "../src/traffic.js";

function config(overrides: Partial<TrafficConfig>): TrafficConfig {
  return { ...DEFAULT_TRAFFIC, ...overrides };
}

describe("generateTraffic", () => {
  it("is deterministic for a seed", () => {
    const a = generateTraffic(config({ requests: 300 }));
    const b = generateTraffic(config({ requests: 300 }));
    expect(a).toEqual(b);
  });

  it("changes with the seed", () => {
    const a = generateTraffic(config({ requests: 300 }));
    const b = generateTraffic(config({ requests: 300, seed: 7 }));
    expect(a.map((r) => r.text)).not.toEqual(b.map((r) => r.text));
  });

  it("produces the requested count with known intents", () => {
    const traffic = generateTraffic(config({ requests: 250 }));
    expect(traffic).toHaveLength(250);
    const known = new Set(INTENTS.map((intent) => intent.id));
    for (const request of traffic) {
      expect(known.has(request.intentId)).toBe(true);
      expect(request.text.length).toBeGreaterThan(0);
    }
  });

  it("skews popularity: the top intent far outdraws the bottom one", () => {
    const traffic = generateTraffic(config({}));
    const counts = new Map<string, number>();
    for (const request of traffic) {
      counts.set(request.intentId, (counts.get(request.intentId) ?? 0) + 1);
    }
    const sorted = [...counts.values()].sort((a, b) => b - a);
    expect(sorted[0]!).toBeGreaterThan(3 * sorted[sorted.length - 1]!);
  });

  it("marks no request typoed when typos are off", () => {
    const traffic = generateTraffic(config({ requests: 200, typoProbability: 0 }));
    expect(traffic.every((request) => !request.typoed)).toBe(true);
  });

  it("typoes most requests when the probability is 1", () => {
    const traffic = generateTraffic(config({ requests: 200, typoProbability: 1 }));
    const typoed = traffic.filter((request) => request.typoed).length;
    expect(typoed).toBeGreaterThan(100);
  });

  it("wraps every request when greeting and tail probabilities are 1", () => {
    const traffic = generateTraffic(
      config({ requests: 100, greetingProbability: 1, tailProbability: 1, typoProbability: 0 }),
    );
    const greetings = ["hey ", "hi ", "hello ", "quick question "];
    const tails = [" please", " thanks", " thank you", " asap"];
    for (const request of traffic) {
      expect(greetings.some((greeting) => request.text.startsWith(greeting))).toBe(true);
      expect(tails.some((tail) => request.text.endsWith(tail))).toBe(true);
    }
  });

  it("handles a single request and an empty request count", () => {
    expect(generateTraffic(config({ requests: 1 }))).toHaveLength(1);
    expect(generateTraffic(config({ requests: 0 }))).toHaveLength(0);
  });
});

describe("applyTypo", () => {
  it("swaps two adjacent letters and preserves the multiset", () => {
    const rng = createRng(42);
    const mutated = applyTypo(rng, "password");
    expect(mutated).toHaveLength("password".length);
    expect([...mutated].sort().join("")).toBe([..."password"].sort().join(""));
  });

  it("leaves text with no word of length four alone", () => {
    const rng = createRng(1);
    expect(applyTypo(rng, "an ox is up")).toBe("an ox is up");
    expect(applyTypo(rng, "")).toBe("");
  });
});
