/**
 * The tool registry: real implementations behind zod-validated schemas.
 * Validation is strict (unknown keys rejected) because tool args feed real
 * code; a silently dropped field is a wrong answer waiting to happen.
 * `fetch_page` sits on a simulated transport with seeded transient faults
 * and reuses the bounded retry loop + full-jitter backoff from
 * 06-rate-limiting instead of reimplementing them.
 */

import { z } from "zod";
import { VirtualClock } from "../../06-rate-limiting/src/clock.js";
import { requestWithRetry } from "../../06-rate-limiting/src/retry.js";
import type { ApiResponse } from "../../06-rate-limiting/src/server.js";
import type { Rng } from "../../05-token-streaming/src/rng.js";
import type { ToolResultBody } from "./messages.js";

export interface CityRecord {
  name: string;
  population: number;
}

export interface NoteRecord {
  title: string;
  body: string;
}

export interface ToolSpec {
  name: string;
  schema: z.ZodType;
  latencyMs: number;
  run: (args: unknown) => Promise<ToolResultBody>;
}

export interface RegistryOptions {
  clock: VirtualClock;
  rng: Rng;
  cities: readonly CityRecord[];
  notes: readonly NoteRecord[];
  /** How many fetch_page transport attempts fail with 503 before one succeeds. */
  fetchTransientFailures: number;
}

export const FETCH_RETRY = {
  policy: { kind: "full-jitter", baseMs: 200, capMs: 5000 } as const,
  maxRetries: 4,
  respectRetryAfter: false,
};

const FETCH_TRANSPORT_LATENCY_MS = 250;

const calcSchema = z.strictObject({
  op: z.enum(["add", "sub", "mul", "div"]),
  a: z.number().finite(),
  b: z.number().finite(),
});

const lookupCitySchema = z.strictObject({
  city: z.string().min(1),
});

const searchNotesSchema = z.strictObject({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(10).optional(),
});

const fetchPageSchema = z.strictObject({
  url: z.url(),
});

export function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

export function buildRegistry(opts: RegistryOptions): Map<string, ToolSpec> {
  const { clock, rng, cities, notes } = opts;
  let fetchFailuresLeft = opts.fetchTransientFailures;

  const calc: ToolSpec = {
    name: "calc",
    schema: calcSchema,
    latencyMs: 5,
    run: async (args) => {
      const { op, a, b } = calcSchema.parse(args);
      if (op === "div" && b === 0) return { ok: false, error: "division by zero" };
      const value = op === "add" ? a + b : op === "sub" ? a - b : op === "mul" ? a * b : a / b;
      return { ok: true, value: String(value) };
    },
  };

  const lookupCity: ToolSpec = {
    name: "lookup_city",
    schema: lookupCitySchema,
    latencyMs: 20,
    run: async (args) => {
      const { city } = lookupCitySchema.parse(args);
      const hit = cities.find((c) => c.name.toLowerCase() === city.toLowerCase());
      if (!hit) return { ok: false, error: `unknown city: ${city}` };
      return { ok: true, value: String(hit.population) };
    },
  };

  const searchNotes: ToolSpec = {
    name: "search_notes",
    schema: searchNotesSchema,
    latencyMs: 30,
    run: async (args) => {
      const { query, limit = 3 } = searchNotesSchema.parse(args);
      const needle = query.toLowerCase();
      const titles = notes
        .filter((n) => n.title.toLowerCase().includes(needle) || n.body.toLowerCase().includes(needle))
        .slice(0, limit)
        .map((n) => n.title);
      return { ok: true, value: titles.length > 0 ? titles.join(", ") : "no matches" };
    },
  };

  const fetchPage: ToolSpec = {
    name: "fetch_page",
    schema: fetchPageSchema,
    latencyMs: 0, // latency lives in the transport attempts below
    run: async (args) => {
      const { url } = fetchPageSchema.parse(args);
      const send = async (): Promise<ApiResponse> => {
        await clock.sleep(FETCH_TRANSPORT_LATENCY_MS);
        if (fetchFailuresLeft > 0) {
          fetchFailuresLeft--;
          return { status: 503 };
        }
        return { status: 200 };
      };
      const outcome = await requestWithRetry(send, clock, rng, FETCH_RETRY);
      if (!outcome.ok) {
        return { ok: false, error: `fetch failed after ${outcome.attempts} attempts (503)` };
      }
      return { ok: true, value: `fetched ${url} status=200 attempts=${outcome.attempts}` };
    },
  };

  return new Map([calc, lookupCity, searchNotes, fetchPage].map((t) => [t.name, t]));
}

export function availableToolNames(registry: Map<string, ToolSpec>): string {
  return [...registry.keys()].join(", ");
}
