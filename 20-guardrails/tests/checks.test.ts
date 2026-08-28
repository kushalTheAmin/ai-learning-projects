import { describe, expect, it } from "vitest";
import { entropyBitsPerChar, luhnValid } from "../src/checks.js";

describe("luhnValid", () => {
  it("accepts known-valid card numbers", () => {
    for (const n of ["4111111111111111", "5555555555554444", "378282246310005", "6011111111111117"]) {
      expect(luhnValid(n)).toBe(true);
    }
  });

  it("rejects numbers that fail the checksum", () => {
    expect(luhnValid("4000123456789010")).toBe(false);
    expect(luhnValid("1234567890123456")).toBe(false);
  });

  it("flips validity when a single digit is corrupted", () => {
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(luhnValid("4111111111111112")).toBe(false);
  });

  it("rejects non-digit input", () => {
    expect(luhnValid("4111-1111")).toBe(false);
    expect(luhnValid("")).toBe(false);
    expect(luhnValid("7")).toBe(false);
  });
});

describe("entropyBitsPerChar", () => {
  it("is zero for a single repeated character", () => {
    expect(entropyBitsPerChar("aaaaaaaa")).toBe(0);
  });

  it("is 1 bit for a balanced two-symbol string", () => {
    expect(entropyBitsPerChar("aaaaaaaaaa1111111111")).toBeCloseTo(1, 10);
  });

  it("ranks a random key above a low-entropy placeholder", () => {
    const key = entropyBitsPerChar("xQ9zR2mK7bV4nT1pL8wY3jH6dF0sA5cG");
    const placeholder = entropyBitsPerChar("aaaaaaaaaa1111111111");
    expect(key).toBeGreaterThan(4);
    expect(placeholder).toBeLessThan(4);
    expect(key).toBeGreaterThan(placeholder);
  });

  it("is empty-string safe", () => {
    expect(entropyBitsPerChar("")).toBe(0);
  });
});
