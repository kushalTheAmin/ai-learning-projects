import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VirtualClock } from "../../06-rate-limiting/src/clock.js";
import { createRng } from "../../05-token-streaming/src/rng.js";
import { buildRegistry, formatIssues, type ToolSpec } from "../src/tools.js";
import { loadCities, loadNotes } from "../src/tasks.js";
import { z } from "zod";

const dataDir = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const cities = loadCities(join(dataDir, "cities.json"));
const notes = loadNotes(join(dataDir, "notes.json"));

function makeRegistry(fetchTransientFailures = 0): {
  registry: Map<string, ToolSpec>;
  clock: VirtualClock;
} {
  const clock = new VirtualClock();
  const registry = buildRegistry({
    clock,
    rng: createRng(7),
    cities,
    notes,
    fetchTransientFailures,
  });
  return { registry, clock };
}

function tool(registry: Map<string, ToolSpec>, name: string): ToolSpec {
  const spec = registry.get(name);
  if (spec === undefined) throw new Error(`missing tool ${name}`);
  return spec;
}

describe("schemas", () => {
  const { registry } = makeRegistry();

  it("calc accepts a valid call", () => {
    expect(tool(registry, "calc").schema.safeParse({ op: "add", a: 1, b: 2 }).success).toBe(true);
  });

  it("calc rejects a string where a number belongs", () => {
    const r = tool(registry, "calc").schema.safeParse({ op: "add", a: "1", b: 2 });
    expect(r.success).toBe(false);
  });

  it("calc rejects a missing field", () => {
    expect(tool(registry, "calc").schema.safeParse({ op: "add", a: 1 }).success).toBe(false);
  });

  it("calc rejects an unknown extra field", () => {
    const r = tool(registry, "calc").schema.safeParse({ op: "add", a: 1, b: 2, precision: 2 });
    expect(r.success).toBe(false);
  });

  it("calc rejects a non-finite number", () => {
    expect(tool(registry, "calc").schema.safeParse({ op: "add", a: Infinity, b: 2 }).success).toBe(
      false,
    );
  });

  it("search_notes bounds limit to [1, 10] integers", () => {
    const schema = tool(registry, "search_notes").schema;
    expect(schema.safeParse({ query: "x", limit: 10 }).success).toBe(true);
    expect(schema.safeParse({ query: "x", limit: 11 }).success).toBe(false);
    expect(schema.safeParse({ query: "x", limit: 0 }).success).toBe(false);
    expect(schema.safeParse({ query: "x", limit: 2.5 }).success).toBe(false);
  });

  it("search_notes rejects an empty query", () => {
    expect(tool(registry, "search_notes").schema.safeParse({ query: "" }).success).toBe(false);
  });

  it("fetch_page rejects a non-url string", () => {
    expect(tool(registry, "fetch_page").schema.safeParse({ url: "not a url" }).success).toBe(false);
  });

  it("formatIssues names the offending path", () => {
    const r = tool(registry, "calc").schema.safeParse({ op: "add", a: "1", b: 2 });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(formatIssues(r.error)).toContain("a:");
    }
  });

  it("formatIssues labels root-level issues", () => {
    const r = z.strictObject({}).safeParse({ stray: 1 });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(formatIssues(r.error)).toContain("(root)");
    }
  });
});

describe("calc", () => {
  const { registry } = makeRegistry();

  it("computes all four ops", async () => {
    const calc = tool(registry, "calc");
    expect(await calc.run({ op: "add", a: 19, b: 23 })).toEqual({ ok: true, value: "42" });
    expect(await calc.run({ op: "sub", a: 100, b: 58 })).toEqual({ ok: true, value: "42" });
    expect(await calc.run({ op: "mul", a: 6, b: 7 })).toEqual({ ok: true, value: "42" });
    expect(await calc.run({ op: "div", a: 84, b: 2 })).toEqual({ ok: true, value: "42" });
  });

  it("returns a tool error on division by zero instead of Infinity", async () => {
    const r = await tool(registry, "calc").run({ op: "div", a: 1, b: 0 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("division by zero");
  });
});

describe("lookup_city", () => {
  const { registry } = makeRegistry();

  it("finds a city case-insensitively", async () => {
    expect(await tool(registry, "lookup_city").run({ city: "tokyo" })).toEqual({
      ok: true,
      value: "37115035",
    });
  });

  it("finds a unicode city name", async () => {
    expect(await tool(registry, "lookup_city").run({ city: "München" })).toEqual({
      ok: true,
      value: "1512491",
    });
  });

  it("errors on an unknown city", async () => {
    const r = await tool(registry, "lookup_city").run({ city: "Atlantis" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Atlantis");
  });
});

describe("search_notes", () => {
  const { registry } = makeRegistry();

  it("matches on title and body, in dataset order, capped by limit", async () => {
    const r = await tool(registry, "search_notes").run({ query: "retry" });
    expect(r).toEqual({ ok: true, value: "retry backoff notes, agent loop budgets, virtual clocks" });
  });

  it("respects an explicit limit", async () => {
    const r = await tool(registry, "search_notes").run({ query: "retry", limit: 1 });
    expect(r).toEqual({ ok: true, value: "retry backoff notes" });
  });

  it("matches unicode queries", async () => {
    const r = await tool(registry, "search_notes").run({ query: "café" });
    expect(r).toEqual({ ok: true, value: "naïve café reading list" });
  });

  it("reports no matches rather than an empty string", async () => {
    const r = await tool(registry, "search_notes").run({ query: "zzz-not-there" });
    expect(r).toEqual({ ok: true, value: "no matches" });
  });

  it("handles an oversized query without matching everything", async () => {
    const r = await tool(registry, "search_notes").run({ query: "x".repeat(10_000) });
    expect(r).toEqual({ ok: true, value: "no matches" });
  });
});

describe("fetch_page", () => {
  it("succeeds first try with no transient failures", async () => {
    const { registry, clock } = makeRegistry(0);
    const r = await clock.runUntil(
      tool(registry, "fetch_page").run({ url: "https://example.com/a" }),
    );
    expect(r).toEqual({ ok: true, value: "fetched https://example.com/a status=200 attempts=1" });
  });

  it("retries through transient 503s with backoff delay on the virtual clock", async () => {
    const { registry, clock } = makeRegistry(2);
    const r = await clock.runUntil(
      tool(registry, "fetch_page").run({ url: "https://example.com/a" }),
    );
    expect(r).toEqual({ ok: true, value: "fetched https://example.com/a status=200 attempts=3" });
    // 3 transport attempts at 250ms plus two backoff sleeps
    expect(clock.now()).toBeGreaterThan(750);
  });

  it("gives up after max retries and says how many attempts it made", async () => {
    const { registry, clock } = makeRegistry(99);
    const r = await clock.runUntil(
      tool(registry, "fetch_page").run({ url: "https://example.com/a" }),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("fetch failed after 5 attempts (503)");
  });

  it("transient failures are consumed across calls within one registry", async () => {
    const { registry, clock } = makeRegistry(1);
    const first = await clock.runUntil(
      tool(registry, "fetch_page").run({ url: "https://example.com/a" }),
    );
    const second = await clock.runUntil(
      tool(registry, "fetch_page").run({ url: "https://example.com/b" }),
    );
    expect(first.value).toContain("attempts=2");
    expect(second.value).toContain("attempts=1");
  });
});
