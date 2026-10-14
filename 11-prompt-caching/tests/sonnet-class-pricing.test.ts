/**
 * The base price the project publishes its dollars at.
 *
 * `src/pricing.ts` says the defaults are "a sonnet-class model", and every
 * other constant in the simulation is that class's published figure: the
 * 1024-token minimum cacheable prefix, 0.1x reads, 1.25x 5m writes, 2x 1h
 * writes, 4 breakpoints, a 20-block lookback. The base price was the one
 * value that departed from the class it named — $2/$10 against the published
 * $3/$15 — and 08, the project this one imports its token estimator from,
 * already prices the same class at $3/$15. So every absolute dollar in the
 * readme was two thirds of what the named model would bill, and the readme's
 * own hedge blamed the gap on token counts and conversation sizes rather than
 * on the base price.
 *
 * Nothing bound those dollars to the run. The volatile sweep table is held
 * character for character by volatile-tail-turn.test.ts, but the prose
 * figures in sections 1-5 were typed, so the price could sit mislabelled
 * without a test objecting.
 *
 * These pin the price to the class the docstring claims, hold it equal to the
 * repo's other sonnet-class price, prove the fix moves dollars and nothing
 * else (every published ratio is price-invariant), and bind the readme's
 * dollar figures to what the two entry points print.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

import { PRICING as SONNET_CLASS_PRICING_08 } from "../../08-agent-tool-loop/src/messages.js";
import { DEFAULT_CACHE_CONFIG } from "../src/cache.js";
import { DEFAULT_PRICING, TTL_1H_MS, TTL_5M_MS, type Pricing } from "../src/pricing.js";
import { DEFAULT_SEED, agentWorkload, replay } from "../src/experiment.js";
import { incremental, none, staticOnly } from "../src/strategies.js";
import { runVolatilePosition } from "../src/volatile-study.js";

const run = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The price the project used to publish at, kept only to prove invariance. */
const RETIRED_PRICING: Pricing = { ...DEFAULT_PRICING, inputPerMTok: 2, outputPerMTok: 10 };

describe("the base price is the class the project names", () => {
  it("bills at the published sonnet-class rates", () => {
    expect(DEFAULT_PRICING.inputPerMTok).toBe(3);
    expect(DEFAULT_PRICING.outputPerMTok).toBe(15);
  });

  it("agrees with the repo's other sonnet-class price", () => {
    // 08 is where this project's token estimator comes from; one repo should
    // not carry two prices for one model class.
    expect(DEFAULT_PRICING.inputPerMTok).toBe(SONNET_CLASS_PRICING_08.inputPerMTok);
    expect(DEFAULT_PRICING.outputPerMTok).toBe(SONNET_CLASS_PRICING_08.outputPerMTok);
  });

  it("leaves every cache-semantics constant at its published value", () => {
    // the multipliers and limits were already right; only the base moved
    expect(DEFAULT_PRICING.readMultiplier).toBe(0.1);
    expect(DEFAULT_PRICING.writeMultiplierByTtlMs[TTL_5M_MS]).toBe(1.25);
    expect(DEFAULT_PRICING.writeMultiplierByTtlMs[TTL_1H_MS]).toBe(2);
    expect(DEFAULT_CACHE_CONFIG.minCacheableTokens).toBe(1024);
    expect(DEFAULT_CACHE_CONFIG.maxBreakpoints).toBe(4);
    expect(DEFAULT_CACHE_CONFIG.lookbackBlocks).toBe(20);
  });
});

describe("the fix moves dollars and nothing else", () => {
  const events = agentWorkload(DEFAULT_SEED, 6, 10, 30_000);
  const strategies = [
    ["none", none],
    ["static-only", staticOnly],
    ["incremental", incremental],
  ] as const;

  it("scales every input bill by exactly the price ratio", () => {
    const scale = DEFAULT_PRICING.inputPerMTok / RETIRED_PRICING.inputPerMTok;
    expect(scale).toBe(1.5);
    for (const [name, strategy] of strategies) {
      const now = replay(events, strategy, TTL_5M_MS, DEFAULT_PRICING).inputCost;
      const before = replay(events, strategy, TTL_5M_MS, RETIRED_PRICING).inputCost;
      expect(now, name).toBeCloseTo(scale * before, 12);
    }
  });

  it("leaves every published ratio, share and token count identical", () => {
    const baselineNow = replay(events, none, TTL_5M_MS, DEFAULT_PRICING).inputCost;
    const baselineBefore = replay(events, none, TTL_5M_MS, RETIRED_PRICING).inputCost;
    for (const [name, strategy] of strategies) {
      const now = replay(events, strategy, TTL_5M_MS, DEFAULT_PRICING);
      const before = replay(events, strategy, TTL_5M_MS, RETIRED_PRICING);
      expect(now.hitRate, name).toBe(before.hitRate);
      expect(now.uncachedTokens, name).toBe(before.uncachedTokens);
      expect(now.readTokens, name).toBe(before.readTokens);
      expect(now.writeTokens, name).toBe(before.writeTokens);
      expect(now.requestsWithHit, name).toBe(before.requestsWithHit);
      expect(1 - now.inputCost / baselineNow, name).toBeCloseTo(1 - before.inputCost / baselineBefore, 12);
    }
  });
});

describe("the readme quotes the price the code bills at", () => {
  const readme = readFileSync(resolve(projectRoot, "README.md"), "utf8");
  // the fixes section quotes the figures it retired, so it is exempt
  const liveProse = readme.split("\n## fixes")[0]!;

  it("names no per-MTok price the pricing model does not configure", () => {
    const configured = [String(DEFAULT_PRICING.inputPerMTok), String(DEFAULT_PRICING.outputPerMTok)];
    const quoted = [...liveProse.matchAll(/\$(\d+(?:\.\d+)?)\/MTok/g)].map((m) => m[1]!);
    expect(quoted.length, "the readme states its base price somewhere").toBeGreaterThan(0);
    for (const price of quoted) expect(configured, `$${price}/MTok`).toContain(price);
  });

  it("does not carry the retired base price", () => {
    expect(liveProse).not.toContain(`$${RETIRED_PRICING.inputPerMTok}/MTok`);
  });
});

describe("the readme's dollar figures are the ones the run prints", () => {
  let printed = new Set<string>();

  beforeAll(async () => {
    const outputs = await Promise.all(
      ["src/main.ts", "src/volatile-main.ts"].map((entry) =>
        run("npx", ["tsx", entry], { cwd: projectRoot, maxBuffer: 32 * 1024 * 1024 }),
      ),
    );
    for (const { stdout } of outputs) {
      for (const match of stdout.matchAll(/\$\d+\.\d{4}(?!\d)/g)) printed.add(match[0]!);
    }
  }, 180_000);

  it("prints a dollar figure at all", () => {
    expect(printed.size).toBeGreaterThan(10);
  });

  it("quotes no four-decimal dollar figure the entry points do not print", () => {
    const readme = readFileSync(resolve(projectRoot, "README.md"), "utf8");
    const liveProse = readme.split("\n## fixes")[0]!;
    const quoted = [...liveProse.matchAll(/\$\d+\.\d{4}(?!\d)/g)].map((m) => m[0]!);
    expect(quoted.length, "the readme quotes measured dollars").toBeGreaterThan(10);
    for (const figure of new Set(quoted)) expect([...printed], figure).toContain(figure);
  });
});

describe("the ledger's position-extension row quotes the run's dollars", () => {
  /** The extension row, which the base row's ledger test deliberately skips. */
  function extensionRow(): string {
    const text = readFileSync(resolve(projectRoot, "../progress.md"), "utf8");
    const completed = text.split("## COMPLETED", 1 + 1)[1]!.split("\n## ", 1)[0]!;
    const rows = completed
      .split("\n")
      .filter((line) => line.startsWith("| 11-prompt-caching, position extension |"));
    expect(rows, "progress.md has no single extension row for 11").toHaveLength(1);
    return rows[0]!;
  }

  it("quotes the assembly-order swing at the price the code bills", () => {
    // the two dollars the row's 2.4x swing is built from: the aware strategy
    // with the block right after the system prompt, against the tail
    const usd = (x: number): string => `$${x.toFixed(4)}`;
    const aware = runVolatilePosition().filter((row) => row.strategy === "aware");
    const at2 = aware.find((row) => row.positionLabel === "2")!;
    const tail = aware.find((row) => row.positionLabel === "tail")!;
    const swing = at2.totals.inputCost / tail.totals.inputCost;
    expect(`${swing.toFixed(1)}x`).toBe("2.4x");
    expect(extensionRow()).toContain(
      `(a ${swing.toFixed(1)}x swing, ${usd(at2.totals.inputCost)} vs ${usd(tail.totals.inputCost)}, ` +
        `from assembly order alone)`,
    );
  });
});
