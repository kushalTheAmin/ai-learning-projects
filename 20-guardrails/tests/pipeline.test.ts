import { describe, expect, it } from "vitest";
import { loadPrompts } from "../src/dataset.js";
import { runPipeline, type PipelineConfig } from "../src/pipeline.js";

const prompts = loadPrompts("data/prompts.json");
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

describe("runPipeline end to end", () => {
  it("matches the published baseline counts", () => {
    const s = runPipeline(prompts, baseline);
    expect(s.attacks).toMatchObject({
      total: 14,
      blockedAtInput: 7,
      caughtByCanary: 4,
      leakedUndetected: 2,
    });
    expect(s.benign).toMatchObject({ total: 12, wronglyBlocked: 1, answered: 11, piiSpansRedacted: 4 });
  });

  it("matches the published hardened counts", () => {
    const s = runPipeline(prompts, hardened);
    expect(s.attacks).toMatchObject({
      total: 14,
      blockedAtInput: 11,
      caughtByCanary: 2,
      leakedUndetected: 1,
    });
    expect(s.benign).toMatchObject({ total: 12, wronglyBlocked: 1, answered: 11, piiSpansRedacted: 4 });
  });

  it("cuts undetected leaks when hardening is on", () => {
    const b = runPipeline(prompts, baseline).attacks.leakedUndetected;
    const h = runPipeline(prompts, hardened).attacks.leakedUndetected;
    expect(h).toBeLessThan(b);
  });

  it("leaves the residual leak as a paraphrase that carries no canary", () => {
    const s = runPipeline(prompts, hardened);
    const leaked = s.outcomes.filter((o) => o.leakedUndetected);
    expect(leaked).toHaveLength(1);
    const item = prompts.find((p) => p.id === leaked[0]!.id);
    expect(item?.model?.leak).toBe("paraphrase");
  });

  it("scrubs pii from benign model output rather than blocking it", () => {
    const s = runPipeline(prompts, hardened);
    const benignWithPii = s.outcomes.filter((o) => o.kind === "benign" && o.piiSpansRedacted > 0);
    expect(benignWithPii.length).toBeGreaterThan(0);
    for (const o of benignWithPii) {
      expect(o.finalResponse).not.toContain("@");
      expect(o.finalResponse).toContain("[");
    }
  });

  it("never blocks at input when the input filter is off", () => {
    const noFilter = runPipeline(prompts, { ...hardened, inputFilter: false });
    expect(noFilter.attacks.blockedAtInput).toBe(0);
    expect(noFilter.benign.wronglyBlocked).toBe(0);
  });
});
