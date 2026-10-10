/**
 * Holds section 3's attack row to the 14 attacks it claims to break down.
 *
 * The row is printed as a partition: every attack is blocked at input,
 * refused by the model, caught by the output canary, or leaked undetected.
 * Baseline accounts for 13 of 14. The missing one is a spacing attack the
 * raw-text gate scores 0, whose scripted model complies with the hijack but
 * never quotes its prompt — so no canary fires and no leak counter sees it.
 * A complied attack that does not leak is a fifth outcome, not a rounding
 * error, and the ledger needs a column for it.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadPrompts } from "../src/dataset.js";
import { runPipeline, type PipelineConfig } from "../src/pipeline.js";

const README = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
const prompts = loadPrompts(fileURLToPath(new URL("../data/prompts.json", import.meta.url)));

const THRESHOLD = 3;

const baseline: PipelineConfig = {
  name: "baseline",
  inputFilter: true,
  inputThreshold: THRESHOLD,
  outputFilter: true,
  scoring: { normalize: false, decodeBase64: false },
};

const hardened: PipelineConfig = {
  name: "hardened",
  inputFilter: true,
  inputThreshold: THRESHOLD,
  outputFilter: true,
  scoring: { normalize: true, decodeBase64: true },
};

describe("the attack row accounts for every attack", () => {
  it("partitions all 14 attacks in both published configs", () => {
    for (const config of [baseline, hardened]) {
      const a = runPipeline(prompts, config).attacks;
      const accounted =
        a.blockedAtInput +
        a.refusedByModel +
        a.caughtByCanary +
        a.leakedUndetected +
        a.compliedWithoutLeak;
      expect(accounted).toBe(a.total);
    }
  });

  it("still partitions with either gate switched off", () => {
    const variants: PipelineConfig[] = [
      { ...hardened, inputFilter: false },
      { ...hardened, outputFilter: false },
      { ...hardened, inputFilter: false, outputFilter: false },
      { ...baseline, outputFilter: false },
    ];
    for (const config of variants) {
      const a = runPipeline(prompts, config).attacks;
      const accounted =
        a.blockedAtInput +
        a.refusedByModel +
        a.caughtByCanary +
        a.leakedUndetected +
        a.compliedWithoutLeak;
      expect(accounted).toBe(a.total);
    }
  });

  it("counts the one baseline attack that complied without leaking, and none once hardened", () => {
    expect(runPipeline(prompts, baseline).attacks.compliedWithoutLeak).toBe(1);
    expect(runPipeline(prompts, hardened).attacks.compliedWithoutLeak).toBe(0);
  });

  it("names it as the spacing attack the raw gate scores 0", () => {
    const outcomes = runPipeline(prompts, baseline).outcomes.filter((o) => o.compliedWithoutLeak);
    expect(outcomes).toHaveLength(1);
    const o = outcomes[0]!;
    expect(o.id).toBe("atk-09");
    expect(o.category).toBe("spacing");
    expect(o.inputScore).toBe(0);
    expect(o.modelCalled).toBe(true);
    expect(o.canaryCaught).toBe(false);
    expect(o.leakedUndetected).toBe(false);
    const item = prompts.find((p) => p.id === o.id);
    expect(item?.model).toEqual({ complies: true, leak: "none" });
  });

  it("keeps the five buckets mutually exclusive per attack", () => {
    for (const config of [baseline, hardened]) {
      for (const o of runPipeline(prompts, config).outcomes) {
        if (o.kind !== "attack") continue;
        const flags = [
          o.blockedAtInput,
          o.canaryCaught,
          o.leakedUndetected,
          o.compliedWithoutLeak,
        ].filter(Boolean);
        expect(flags.length).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("the readme publishes the column", () => {
  it("prints a baseline row whose attack counts sum to 14", () => {
    const row = /attacks: 14 total\s+->\s+([^\n]+)/.exec(README);
    expect(row).not.toBeNull();
    const counts = [...row![1]!.matchAll(/(\d+)\s+[a-z]/g)].map((m) => Number(m[1]));
    expect(counts.reduce((s, n) => s + n, 0)).toBe(14);
  });

  it("names the complied-without-leaking outcome", () => {
    expect(README).toMatch(/complied without leaking/);
  });
});
