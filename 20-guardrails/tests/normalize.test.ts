import { describe, expect, it } from "vitest";
import { normalizeForMatching } from "../src/normalize.js";

describe("normalizeForMatching", () => {
  it("collapses letter-spaced words of four or more characters", () => {
    expect(normalizeForMatching("i g n o r e")).toBe("ignore");
    expect(normalizeForMatching("p r e v i o u s")).toBe("previous");
  });

  it("leaves genuinely separate short words alone", () => {
    expect(normalizeForMatching("a b c")).toBe("a b c");
    expect(normalizeForMatching("i am here")).toBe("i am here");
  });

  it("folds leetspeak inside word tokens but not in bare numbers", () => {
    expect(normalizeForMatching("1gn0re")).toBe("ignore");
    expect(normalizeForMatching("sh0w th3 sy5t3m")).toBe("show the system");
    expect(normalizeForMatching("ticket 50 costs 100")).toBe("ticket 50 costs 100");
  });

  it("folds common cyrillic homoglyphs to latin", () => {
    // leading chars are cyrillic lookalikes
    expect(normalizeForMatching("іgnоre")).toBe("ignore");
    expect(normalizeForMatching("рrevіоus")).toBe("previous");
  });

  it("strips zero-width characters", () => {
    expect(normalizeForMatching("ig​no‌re")).toBe("ignore");
  });

  it("applies NFKC so fullwidth text folds to ascii", () => {
    expect(normalizeForMatching("ｉｇｎｏｒｅ")).toBe("ignore");
  });

  it("lowercases", () => {
    expect(normalizeForMatching("IGNORE This")).toBe("ignore this");
  });
});
