import { describe, expect, it } from "vitest";
import { foldText, LADDER, parseDate, parseNumeric, valuesMatch, FULL, STRICT } from "../src/normalize.js";

const L1 = LADDER[1]!.options;
const L2 = LADDER[2]!.options;

describe("foldText", () => {
  it("folds case, whitespace, and compatibility forms", () => {
    expect(foldText("  Acme   Industrial\tSupply ")).toBe("acme industrial supply");
    expect(foldText("ﬁne")).toBe("fine");
  });
});

describe("parseNumeric", () => {
  it("parses plain and grouped numbers with optional currency symbols", () => {
    expect(parseNumeric(42)).toBe(42);
    expect(parseNumeric("42")).toBe(42);
    expect(parseNumeric("-3.5")).toBe(-3.5);
    expect(parseNumeric("1,234.50")).toBe(1234.5);
    expect(parseNumeric("$1,234.50")).toBe(1234.5);
    expect(parseNumeric("€ 4,800")).toBe(4800);
    expect(parseNumeric("¥48,500.00")).toBe(48500);
  });

  it("rejects non-numbers", () => {
    expect(parseNumeric("")).toBeNull();
    expect(parseNumeric("42abc")).toBeNull();
    expect(parseNumeric("1,23")).toBeNull();
    expect(parseNumeric("12,34,567")).toBeNull();
    expect(parseNumeric(true)).toBeNull();
    expect(parseNumeric(null)).toBeNull();
    expect(parseNumeric(Number.POSITIVE_INFINITY)).toBeNull();
    expect(parseNumeric(Number.NaN)).toBeNull();
  });
});

describe("parseDate", () => {
  it("parses the three supported formats to ISO", () => {
    expect(parseDate("2024-01-05")).toBe("2024-01-05");
    expect(parseDate("Jan 5, 2024")).toBe("2024-01-05");
    expect(parseDate("January 5 2024")).toBe("2024-01-05");
    expect(parseDate("5 January 2024")).toBe("2024-01-05");
    expect(parseDate("28 feb 2024")).toBe("2024-02-28");
  });

  it("rejects ambiguous, invalid, and non-date input", () => {
    expect(parseDate("05/01/2024")).toBeNull();
    expect(parseDate("Foo 5, 2024")).toBeNull();
    expect(parseDate("Feb 31, 2024")).toBeNull();
    expect(parseDate("2024-13-01")).toBeNull();
    expect(parseDate("net 30")).toBeNull();
    expect(parseDate(42)).toBeNull();
    expect(parseDate(null)).toBeNull();
  });
});

describe("valuesMatch across the ladder", () => {
  it("L0 is strict identity", () => {
    expect(valuesMatch("USD", "USD", STRICT)).toBe(true);
    expect(valuesMatch("USD", "usd", STRICT)).toBe(false);
    expect(valuesMatch(42, "42", STRICT)).toBe(false);
    expect(valuesMatch(null, null, STRICT)).toBe(true);
  });

  it("L1 forgives case and whitespace but not numbers-as-strings", () => {
    expect(valuesMatch("Acme Supply", "  ACME   supply ", L1)).toBe(true);
    expect(valuesMatch(42, "42", L1)).toBe(false);
  });

  it("L2 matches number-shaped strings to numbers within tolerance", () => {
    expect(valuesMatch(42, "42", L2)).toBe(true);
    expect(valuesMatch(1234.5, "$1,234.50", L2)).toBe(true);
    expect(valuesMatch(1234.5, "$1,234.51", L2)).toBe(false);
    expect(valuesMatch(42, "forty-two", L2)).toBe(false);
    expect(valuesMatch(0, "0.00", L2)).toBe(true);
  });

  it("numeric tolerance binds exactly at the boundary", () => {
    const tol = { ...L2, numericTolerance: 0.01 };
    expect(valuesMatch(10, 10.01, tol)).toBe(true);
    expect(valuesMatch(10, 10.011, tol)).toBe(false);
  });

  it("L3 matches date forms and still refuses different dates", () => {
    expect(valuesMatch("2024-01-05", "Jan 5, 2024", FULL)).toBe(true);
    expect(valuesMatch("2024-01-05", "Jan 6, 2024", FULL)).toBe(false);
    expect(valuesMatch("2024-01-05", "05/01/2024", FULL)).toBe(false);
  });

  it("a number against a non-numeric string never falls through to text folding", () => {
    expect(valuesMatch(42, "42x", FULL)).toBe(false);
    expect(valuesMatch("42", "42x", FULL)).toBe(false);
  });

  it("booleans and nulls only match themselves at every level", () => {
    expect(valuesMatch(true, "true", FULL)).toBe(false);
    expect(valuesMatch(null, "", FULL)).toBe(false);
    expect(valuesMatch(true, true, FULL)).toBe(true);
  });
});
