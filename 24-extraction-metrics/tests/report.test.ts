import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { INVOICES } from "../src/dataset.js";
import { countLeaves, macroF1, microMetrics } from "../src/compare.js";
import { FULL, STRICT } from "../src/normalize.js";
import { exactMatchRate, runExtractors, scoreRun } from "../src/report.js";
import type { JsonValue } from "../src/json.js";

const runs = runExtractors();

function run(name: string) {
  const found = runs.find((r) => r.extractor.name === name);
  if (found === undefined) throw new Error(`no run named ${name}`);
  return found;
}

describe("scoring over the full dataset", () => {
  it("perfect scores 1.0 everywhere and its correct count equals the gold leaf count", () => {
    const goldLeaves = INVOICES.reduce((n, inv) => n + countLeaves(inv as unknown as JsonValue), 0);
    const result = scoreRun(run("perfect"), STRICT, "index");
    expect(result.total).toEqual({ correct: goldLeaves, wrong: 0, missing: 0, spurious: 0 });
    expect(exactMatchRate(run("perfect"))).toBe(1);
  });

  it("exact match cannot separate format drift from corruption; semantic F1 separates them fully", () => {
    expect(exactMatchRate(run("format-drift"))).toBe(0);
    expect(exactMatchRate(run("corruptor"))).toBe(0);
    const drift = microMetrics(scoreRun(run("format-drift"), FULL, "aligned").total).f1;
    const corrupt = microMetrics(scoreRun(run("corruptor"), FULL, "aligned").total).f1;
    expect(drift).toBe(1);
    expect(corrupt).toBeLessThan(0.8);
  });

  it("normalization rescues format drift stepwise but never moves the corruptor", () => {
    const driftStrict = microMetrics(scoreRun(run("format-drift"), STRICT, "aligned").total).f1;
    expect(driftStrict).toBeLessThan(0.3);
    const corruptStrict = microMetrics(scoreRun(run("corruptor"), STRICT, "aligned").total).f1;
    const corruptFull = microMetrics(scoreRun(run("corruptor"), FULL, "aligned").total).f1;
    expect(corruptFull).toBeCloseTo(corruptStrict, 10);
  });

  it("alignment recovers the shuffler completely and only the shuffler", () => {
    for (const r of runs) {
      const byIndex = microMetrics(scoreRun(r, FULL, "index").total).f1;
      const aligned = microMetrics(scoreRun(r, FULL, "aligned").total).f1;
      if (r.extractor.name === "shuffler") {
        expect(byIndex).toBeLessThan(1);
        expect(aligned).toBe(1);
      } else {
        expect(aligned, r.extractor.name).toBeCloseTo(byIndex, 10);
      }
    }
  });

  it("the tax-bungler's broken field is invisible in micro and named per path", () => {
    const result = scoreRun(run("tax-bungler"), FULL, "aligned");
    expect(microMetrics(result.total).f1).toBeGreaterThan(0.9);
    const tax = result.perPath.get("totals.tax");
    expect(tax).toBeDefined();
    expect(microMetrics(tax!).f1).toBe(0);
    expect(macroF1(result.perPath).macroF1).toBeLessThan(microMetrics(result.total).f1);
  });

  it("macro over gold paths is blind to hallucinated structure", () => {
    const result = scoreRun(run("hallucinator"), FULL, "aligned");
    expect(macroF1(result.perPath).macroF1).toBeGreaterThan(microMetrics(result.total).f1);
    expect(microMetrics(result.total).precision).toBeLessThan(1);
  });
});

describe("entry point", () => {
  it("runs end to end and prints the headline tables", () => {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const tsx = path.join(projectRoot, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
    const out = execFileSync(tsx, ["src/main.ts"], { cwd: projectRoot, encoding: "utf8", timeout: 120_000 });
    expect(out).toContain("== exact match vs field-level scoring ==");
    expect(out).toContain("== normalization ladder (greedy-aligned arrays, micro F1) ==");
    expect(out).toContain("== array alignment policy (L3 normalization, micro F1) ==");
    expect(out).toContain("totals.tax");
    expect(out).toMatch(/format-drift\s+0\.000/);
  }, 120_000);
});
