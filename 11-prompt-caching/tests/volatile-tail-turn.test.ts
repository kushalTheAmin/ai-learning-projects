/**
 * The position extension published the aware curve as monotone and the tail
 * as its floor. Swept at every index instead of the nine the table samples,
 * the curve turns at 42 and rises to the tail, and the whole rise is the last
 * request's own write: a deeper breakpoint on the final request bills tokens
 * at 1.25x that no later request ever reads back. This pins the turn, pins
 * the mechanism, puts the minimum in the printed sweep, and holds the readme
 * to what it prints.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_PRICING, TTL_5M_MS } from "../src/pricing.js";
import { none } from "../src/strategies.js";
import { DEFAULT_SEED, replay, type ReplayEvent, type ReplayTotals } from "../src/experiment.js";
import { makeConversation, renderConversation } from "../src/workload.js";
import {
  addVolatileBlock,
  runVolatilePosition,
  SWEEP_POSITIONS,
  TAIL_POSITION,
  volatileAware,
  VOLATILE_GAP_MS,
  VOLATILE_TOOL_BLOCKS_PER_TURN,
  VOLATILE_TURNS,
  type VolatileRenderedRequest,
} from "../src/volatile-study.js";

const run = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The study's own conversation, reproduced turn for turn. */
const base = renderConversation(makeConversation(DEFAULT_SEED + 21, VOLATILE_TURNS, VOLATILE_TOOL_BLOCKS_PER_TURN));
/** Index of the final request's tail, the deepest position the sweep can reach. */
const TAIL_INDEX = base[base.length - 1]!.blocks.length - 1;

interface Scanned {
  position: number;
  ratio: number;
  totals: ReplayTotals;
}

function scan(position: number): Scanned {
  const requests = addVolatileBlock(base, position);
  const events: ReplayEvent<VolatileRenderedRequest>[] = requests.map((request, i) => ({
    request,
    arrivalMs: i * VOLATILE_GAP_MS,
  }));
  const baseline = replay(events, none, TTL_5M_MS).inputCost;
  const totals = replay(events, volatileAware, TTL_5M_MS);
  return { position, ratio: totals.inputCost / baseline, totals };
}

/** Every position the block can occupy, not just the nine the table samples. */
const dense: Scanned[] = Array.from({ length: TAIL_INDEX + 1 }, (_, p) => scan(p));
const lastWrite = (s: Scanned): number => s.totals.writeTokensPerRequest[s.totals.writeTokensPerRequest.length - 1]!;

describe("the aware curve turns before the tail", () => {
  it("bottoms at position 42, not at the tail", () => {
    const best = dense.reduce((a, b) => (b.ratio < a.ratio ? b : a));
    expect(TAIL_INDEX).toBe(46);
    expect(best.position).toBe(42);
    expect(best.ratio).toBeCloseTo(0.299286, 6);
  });

  it("costs strictly more at the tail than four positions earlier", () => {
    const tail = dense[TAIL_INDEX]!;
    expect(tail.ratio).toBeCloseTo(0.301058, 6);
    expect(tail.ratio).toBeGreaterThan(dense[42]!.ratio);
    // and the rise is not a rounding artifact of the printed three decimals
    expect(tail.ratio - dense[42]!.ratio).toBeGreaterThan(1e-4);
  });

  it("rises monotonically over the last four positions", () => {
    for (let p = 43; p <= TAIL_INDEX; p++) {
      expect(dense[p]!.ratio).toBeGreaterThan(dense[p - 1]!.ratio);
    }
  });

  it("sampling only the published grid hides the turn", () => {
    // 38 steps straight to the tail, so the nine sampled rows are monotone
    // while the curve they sample is not.
    const sampled = [0, 1, 2, 6, 14, 22, 30, 38, TAIL_INDEX].map((p) => dense[p]!.ratio);
    for (let i = 1; i < sampled.length; i++) {
      expect(sampled[i]!).toBeLessThanOrEqual(sampled[i - 1]! + 1e-12);
    }
  });
});

describe("the turn is the last request's unamortized write", () => {
  it("saturates the read at 42: no deeper breakpoint buys another read token", () => {
    for (let p = 42; p <= TAIL_INDEX; p++) {
      expect(dense[p]!.totals.readTokens).toBe(37591);
    }
  });

  it("leaves the final request the only thing still moving past 42", () => {
    // every earlier request bills identically from 42 on; only the last one
    // writes more as the block moves deeper
    const at42 = dense[42]!.totals.writeTokensPerRequest;
    for (let p = 43; p <= TAIL_INDEX; p++) {
      const here = dense[p]!.totals.writeTokensPerRequest;
      expect(here.slice(0, -1)).toEqual(at42.slice(0, -1));
      expect(here[here.length - 1]!).toBeGreaterThan(at42[at42.length - 1]!);
    }
    expect(lastWrite(dense[42]!)).toBe(0);
    expect(lastWrite(dense[TAIL_INDEX]!)).toBe(328);
  });

  it("prices the whole tail-vs-minimum gap as that write's 1.25x premium", () => {
    const perTok = DEFAULT_PRICING.inputPerMTok / 1e6;
    const premium = DEFAULT_PRICING.writeMultiplierByTtlMs[TTL_5M_MS]! - 1;
    for (let p = 43; p <= TAIL_INDEX; p++) {
      const extra = lastWrite(dense[p]!) * perTok * premium;
      expect(dense[p]!.totals.inputCost - dense[42]!.totals.inputCost).toBeCloseTo(extra, 12);
    }
    expect(dense[TAIL_INDEX]!.totals.inputCost - dense[42]!.totals.inputCost).toBeCloseTo(0.000164, 6);
  });

  it("keeps the last five positions within 0.6% of each other", () => {
    const last = dense.slice(42).map((s) => s.ratio);
    const spread = Math.max(...last) / Math.min(...last) - 1;
    expect(last).toHaveLength(5);
    expect(`${(100 * spread).toFixed(1)}%`).toBe("0.6%");
  });

  it("never reads that write back", () => {
    // the deeper tail breakpoint buys the run nothing: same hits, same reads
    expect(dense[TAIL_INDEX]!.totals.requestsWithHit).toBe(dense[42]!.totals.requestsWithHit);
    expect(dense[TAIL_INDEX]!.totals.readTokens).toBe(dense[42]!.totals.readTokens);
  });
});

describe("the published sweep samples the turn", () => {
  it("carries a position between 38 and the tail", () => {
    const interior = SWEEP_POSITIONS.filter(
      (p) => p.position !== TAIL_POSITION && p.position > 38 && p.position < TAIL_INDEX,
    );
    expect(interior.map((p) => p.position)).toEqual([42]);
  });

  it("prints a row cheaper than the tail row", () => {
    const aware = runVolatilePosition().filter((row) => row.strategy === "aware");
    const tailRow = aware.find((row) => row.positionLabel === "tail")!;
    const minRow = aware.reduce((a, b) => (b.costRatioVsNone < a.costRatioVsNone ? b : a));
    expect(minRow.positionLabel).toBe("42");
    expect(minRow.costRatioVsNone).toBeLessThan(tailRow.costRatioVsNone);
  });
});

describe("the entry point and the readme", () => {
  let stdout = "";

  beforeAll(async () => {
    ({ stdout } = await run("npx", ["tsx", "src/volatile-main.ts"], {
      cwd: projectRoot,
      maxBuffer: 32 * 1024 * 1024,
    }));
  }, 180_000);

  it("prints the minimum row above the tail row", () => {
    const rows = stdout.split("\n").map((l) => l.trimEnd());
    const min = rows.find((l) => l.startsWith("42       42         aware"))!;
    const tail = rows.find((l) => l.startsWith("tail     46         aware"))!;
    expect(min).toBeDefined();
    expect(tail).toBeDefined();
    expect(min.trim().split(/\s+/)).toEqual([
      "42",
      "42",
      "aware",
      "$0.0277",
      "0.299x",
      "81.2%",
      "3108/37591/5589",
    ]);
    expect(rows.indexOf(min)).toBeLessThan(rows.indexOf(tail));
  });

  it("quotes the printed sweep character for character", () => {
    const readme = readFileSync(resolve(projectRoot, "README.md"), "utf8");
    // fence 1 is the "run it" block, fence 2 is the sweep
    const block = readme.split("```")[3]!;
    expect(block).toContain("position final idx  strategy");
    const printed = new Set(stdout.split("\n").map((l) => l.trimEnd()));
    for (const line of block.split("\n")) {
      if (line.trim() === "") continue;
      expect(printed.has(line.trimEnd()), line).toBe(true);
    }
  });
});

describe("the readme prose", () => {
  const readme = readFileSync(resolve(projectRoot, "README.md"), "utf8");
  // the fixes section quotes the sentence it retired, so it is exempt
  const liveProse = readme.split("\n## fixes")[0]!;
  // whitespace-normalized so a line wrap cannot make these pass
  const flat = liveProse.replace(/\s+/g, " ");

  it("no longer calls the aware curve monotone", () => {
    expect(flat).not.toContain("the aware curve falls monotonically");
    expect(flat).not.toContain("falls monotonically toward the stable floor");
  });

  it("names the minimum and the rise back to the tail", () => {
    expect(flat).toContain("0.299x");
    expect(flat).toContain("position 42");
  });

  it("explains the rise as the last request's unread write", () => {
    expect(flat).toContain("328");
    expect(flat).toContain("$0.000164");
  });

  it("still quotes the sentence it retired, in the fixes section", () => {
    expect(readme).toContain("the aware curve falls monotonically");
  });
});
