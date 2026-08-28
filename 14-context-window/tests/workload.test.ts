import { describe, expect, test } from "vitest";
import {
  DEFAULT_WORKLOAD,
  generateConversation,
  generateConversations,
  validateConversation,
} from "../src/workload.js";

const CFG = { seed: 42, ...DEFAULT_WORKLOAD };

describe("generateConversation", () => {
  test("same seed gives an identical conversation", () => {
    expect(generateConversation(CFG)).toEqual(generateConversation(CFG));
  });

  test("different seeds give different conversations", () => {
    const a = generateConversation(CFG);
    const b = generateConversation({ ...CFG, seed: 43 });
    expect(a.turns.map((t) => t.text).join("\n")).not.toBe(b.turns.map((t) => t.text).join("\n"));
  });

  test("turns alternate user/assistant, user first, 2 per exchange", () => {
    const c = generateConversation(CFG);
    expect(c.turns.length).toBe(2 * c.exchanges);
    c.turns.forEach((t, i) => expect(t.role).toBe(i % 2 === 0 ? "user" : "assistant"));
  });

  test("bucket and class quotas: 4 per lag bucket, 6 per class", () => {
    const c = generateConversation(CFG);
    const buckets = { short: 0, medium: 0, long: 0 };
    const classes = { standalone: 0, buried: 0 };
    for (const f of c.facts) {
      buckets[f.bucket]++;
      classes[f.cls]++;
    }
    expect(buckets).toEqual({ short: 4, medium: 4, long: 4 });
    expect(classes).toEqual({ standalone: 6, buried: 6 });
  });

  test("lags stay inside their bucket ranges and probes land after intros", () => {
    const c = generateConversation(CFG);
    const ranges = { short: [1, 2], medium: [3, 8], long: [9, 20] } as const;
    for (const f of c.facts) {
      const [lo, hi] = ranges[f.bucket];
      expect(f.lag).toBeGreaterThanOrEqual(lo);
      expect(f.lag).toBeLessThanOrEqual(hi);
      expect(f.probeExchange).toBe(f.introExchange + f.lag);
      expect(f.probeExchange).toBeLessThan(c.exchanges);
    }
  });

  test("intro exchanges are distinct, probe exchanges are distinct", () => {
    const c = generateConversation(CFG);
    expect(new Set(c.facts.map((f) => f.introExchange)).size).toBe(c.facts.length);
    expect(new Set(c.facts.map((f) => f.probeExchange)).size).toBe(c.facts.length);
  });

  test("each value occurs exactly once, in its intro assistant turn", () => {
    const c = generateConversation(CFG);
    const all = c.turns.map((t) => t.text).join("\n");
    for (const f of c.facts) {
      expect(all.split(f.value).length - 1).toBe(1);
      const intro = c.turns[2 * f.introExchange + 1];
      expect(intro?.role).toBe("assistant");
      expect(intro?.text).toContain(f.value);
      expect(intro?.text).toContain(f.key);
    }
  });

  test("the probe asks by key and never leaks the value", () => {
    const c = generateConversation(CFG);
    for (const f of c.facts) {
      const probe = c.turns[2 * f.probeExchange];
      expect(probe?.role).toBe("user");
      expect(probe?.text).toContain(f.key);
      expect(probe?.text).not.toContain(f.value);
    }
  });

  test("values are unique within a conversation", () => {
    const c = generateConversation(CFG);
    expect(new Set(c.facts.map((f) => f.value)).size).toBe(c.facts.length);
  });

  test("rejects a fact count the key bank cannot cover", () => {
    expect(() => generateConversation({ seed: 1, exchanges: 40, factCount: 13 })).toThrow(/key bank/);
  });

  test("rejects more facts than event slots", () => {
    expect(() => generateConversation({ seed: 1, exchanges: 10, factCount: 6 })).toThrow(/event slots/);
  });

  test("validateConversation catches a duplicated value", () => {
    const c = generateConversation(CFG);
    const f = c.facts[0];
    if (f === undefined) throw new Error("no facts");
    const broken = {
      ...c,
      turns: c.turns.map((t, i) => (i === 0 ? { ...t, text: `${t.text} ${f.value}` } : t)),
    };
    expect(() => validateConversation(broken)).toThrow(/occurs 2 times/);
  });
});

describe("generateConversations", () => {
  test("produces the requested count with distinct seeds and all valid", () => {
    const cs = generateConversations(1000, 5);
    expect(cs.length).toBe(5);
    for (const c of cs) validateConversation(c);
  });
});
