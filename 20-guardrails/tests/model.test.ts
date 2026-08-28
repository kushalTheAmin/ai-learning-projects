import { describe, expect, it } from "vitest";
import { CANARY, buildSystemPrompt, scriptedModel } from "../src/model.js";
import type { PromptItem } from "../src/dataset.js";

function attack(leak: "verbatim" | "paraphrase" | "none", complies = true): PromptItem {
  return { id: "t", kind: "attack", category: "exfiltration", text: "x", piiSpans: [], model: { complies, leak } };
}

describe("scriptedModel", () => {
  const sys = buildSystemPrompt();

  it("puts the canary in a verbatim leak and nowhere else", () => {
    expect(scriptedModel(attack("verbatim"), sys)).toContain(CANARY);
    expect(scriptedModel(attack("paraphrase"), sys)).not.toContain(CANARY);
    expect(scriptedModel(attack("none"), sys)).not.toContain(CANARY);
  });

  it("refuses when the attack does not comply", () => {
    const out = scriptedModel(attack("none", false), sys);
    expect(out.toLowerCase()).toContain("cant help");
  });

  it("echoes benign user text so its pii reaches the output", () => {
    const benign: PromptItem = { id: "b", kind: "benign", category: "benign", text: "email a@b.com", piiSpans: [] };
    expect(scriptedModel(benign, sys)).toContain("a@b.com");
  });

  it("is a pure function of its inputs", () => {
    expect(scriptedModel(attack("verbatim"), sys)).toBe(scriptedModel(attack("verbatim"), sys));
  });
});
