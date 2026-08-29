import { describe, expect, it } from "vitest";
import { INVOICES } from "../src/dataset.js";
import { EXTRACTORS, extractorRng } from "../src/extractors.js";
import { compare, microMetrics } from "../src/compare.js";
import { deepEqual, flatten, isPrimitive, type JsonValue } from "../src/json.js";
import { FULL, STRICT } from "../src/normalize.js";

function extractor(name: string) {
  const found = EXTRACTORS.find((e) => e.name === name);
  if (found === undefined) throw new Error(`no extractor named ${name}`);
  return found;
}

function goldJson(i: number): JsonValue {
  return INVOICES[i] as unknown as JsonValue;
}

describe("determinism", () => {
  it("every extractor emits identical output for the same seed", () => {
    EXTRACTORS.forEach((e, ei) => {
      INVOICES.forEach((inv, ri) => {
        const a = e.run(inv, extractorRng(7, ei, ri));
        const b = e.run(inv, extractorRng(7, ei, ri));
        expect(deepEqual(a, b), `${e.name} on record ${ri}`).toBe(true);
      });
    });
  });

  it("extractors never mutate the gold record", () => {
    const before = structuredClone(INVOICES);
    EXTRACTORS.forEach((e, ei) => {
      INVOICES.forEach((inv, ri) => e.run(inv, extractorRng(7, ei, ri)));
    });
    expect(INVOICES).toEqual(before);
  });
});

describe("perfect", () => {
  it("deep-equals the gold record", () => {
    INVOICES.forEach((inv, ri) => {
      expect(deepEqual(extractor("perfect").run(inv, extractorRng(7, 0, ri)), goldJson(ri))).toBe(true);
    });
  });
});

describe("format-drift", () => {
  it("never deep-equals gold but is field-perfect under full normalization", () => {
    INVOICES.forEach((inv, ri) => {
      const pred = extractor("format-drift").run(inv, extractorRng(7, 1, ri));
      expect(deepEqual(pred, goldJson(ri))).toBe(false);
      const semantic = microMetrics(compare(goldJson(ri), pred, FULL, "aligned").total);
      expect(semantic.f1, `record ${ri}`).toBe(1);
    });
  });
});

describe("shuffler", () => {
  it("keeps every value; only order moves, so aligned scoring is perfect", () => {
    INVOICES.forEach((inv, ri) => {
      const pred = extractor("shuffler").run(inv, extractorRng(7, 2, ri));
      const aligned = microMetrics(compare(goldJson(ri), pred, STRICT, "aligned").total);
      expect(aligned.f1, `record ${ri}`).toBe(1);
    });
  });
});

describe("tax-bungler", () => {
  it("gets exactly one leaf wrong per record", () => {
    INVOICES.forEach((inv, ri) => {
      const pred = extractor("tax-bungler").run(inv, extractorRng(7, 3, ri));
      const t = compare(goldJson(ri), pred, FULL, "aligned").total;
      expect(t.wrong).toBe(1);
      expect(t.missing).toBe(0);
      expect(t.spurious).toBe(0);
    });
  });
});

describe("lazy", () => {
  it("keeps at most 2 line items and everything else intact", () => {
    INVOICES.forEach((inv, ri) => {
      const pred = extractor("lazy").run(inv, extractorRng(7, 4, ri)) as { line_items: JsonValue[] };
      expect(pred.line_items.length).toBe(Math.min(inv.line_items.length, 2));
      const t = compare(goldJson(ri), pred, STRICT, "index").total;
      expect(t.wrong).toBe(0);
      expect(t.spurious).toBe(0);
    });
  });
});

describe("dropper", () => {
  it("only removes leaves: strict precision stays 1.0 and something goes missing overall", () => {
    let missing = 0;
    INVOICES.forEach((inv, ri) => {
      const pred = extractor("dropper").run(inv, extractorRng(7, 5, ri));
      const t = compare(goldJson(ri), pred, STRICT, "index").total;
      expect(t.wrong).toBe(0);
      expect(t.spurious).toBe(0);
      missing += t.missing;
    });
    expect(missing).toBeGreaterThan(0);
  });
});

describe("hallucinator", () => {
  it("adds structure without losing any gold leaf: recall 1.0, precision below 1.0", () => {
    INVOICES.forEach((inv, ri) => {
      const pred = extractor("hallucinator").run(inv, extractorRng(7, 6, ri));
      const m = microMetrics(compare(goldJson(ri), pred, FULL, "aligned").total);
      expect(m.recall, `record ${ri}`).toBe(1);
      expect(m.precision, `record ${ri}`).toBeLessThan(1);
    });
  });
});

describe("corruptor", () => {
  it("preserves leaf types and paths while breaking values", () => {
    let wrong = 0;
    INVOICES.forEach((inv, ri) => {
      const pred = extractor("corruptor").run(inv, extractorRng(7, 7, ri));
      const goldLeaves = flatten(goldJson(ri));
      const predLeaves = flatten(pred);
      expect(predLeaves.length).toBe(goldLeaves.length);
      predLeaves.forEach((leaf, li) => {
        expect(isPrimitive(leaf.value)).toBe(true);
        expect(typeof leaf.value).toBe(typeof (goldLeaves[li] as { value: unknown }).value);
      });
      wrong += compare(goldJson(ri), pred, FULL, "aligned").total.wrong;
    });
    expect(wrong).toBeGreaterThan(0);
  });
});
