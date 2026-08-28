import { describe, expect, it } from "vitest";
import { answerFor, INTENTS, phrasings, validateDataset, type Intent } from "../src/dataset.js";

function makeIntent(overrides: Partial<Intent>): Intent {
  return {
    id: "intent-a",
    family: "family-a",
    canonical: "do the first thing",
    trivial: ["hey do the first thing", "please do the first thing now"],
    paraphrases: ["handle item one", "take care of the initial task", "sort out number one"],
    answer: "done",
    ...overrides,
  };
}

function sibling(overrides: Partial<Intent>): Intent {
  return makeIntent({
    id: "intent-b",
    canonical: "do the second thing",
    trivial: ["hey do the second thing", "please do the second thing now"],
    paraphrases: ["handle item two", "take care of the next task", "sort out number two"],
    ...overrides,
  });
}

describe("committed dataset", () => {
  it("passes validation", () => {
    expect(() => validateDataset(INTENTS)).not.toThrow();
  });

  it("has at least six phrasings per intent", () => {
    for (const intent of INTENTS) {
      expect(phrasings(intent).length).toBeGreaterThanOrEqual(6);
    }
  });

  it("groups every intent into a family with a sibling", () => {
    const sizes = new Map<string, number>();
    for (const intent of INTENTS) {
      sizes.set(intent.family, (sizes.get(intent.family) ?? 0) + 1);
    }
    for (const size of sizes.values()) expect(size).toBeGreaterThanOrEqual(2);
  });
});

describe("validateDataset", () => {
  it("rejects an empty dataset", () => {
    expect(() => validateDataset([])).toThrow(/empty/);
  });

  it("rejects duplicate normalized phrasings across intents", () => {
    const a = makeIntent({});
    const b = sibling({ canonical: "Do the FIRST thing!" });
    expect(() => validateDataset([a, b])).toThrow(/collision/);
  });

  it("rejects an intent with too few paraphrases", () => {
    const a = makeIntent({ paraphrases: ["handle item one", "sort out number one"] });
    expect(() => validateDataset([a, sibling({})])).toThrow(/paraphrases/);
  });

  it("rejects an empty answer", () => {
    const a = makeIntent({ answer: "   " });
    expect(() => validateDataset([a, sibling({})])).toThrow(/answer/);
  });

  it("rejects a family with a single intent", () => {
    const lonely = sibling({ family: "family-b" });
    expect(() => validateDataset([makeIntent({}), lonely])).toThrow(/single intent/);
  });

  it("rejects duplicate intent ids", () => {
    expect(() => validateDataset([makeIntent({}), sibling({ id: "intent-a" })])).toThrow(/duplicate intent id/);
  });
});

describe("answerFor", () => {
  it("returns the intent's answer", () => {
    const first = INTENTS[0]!;
    expect(answerFor(first.id)).toBe(first.answer);
  });

  it("throws on an unknown intent", () => {
    expect(() => answerFor("no-such-intent")).toThrow(/unknown intent/);
  });
});
