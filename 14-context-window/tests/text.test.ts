import { describe, expect, test } from "vitest";
import { sentences, STOPWORDS, words } from "../src/text.js";

describe("words", () => {
  test("lowercases and splits on non-word characters", () => {
    expect(words("The Deploy went FINE!")).toEqual(["the", "deploy", "went", "fine"]);
  });

  test("keeps hyphen and underscore compounds whole", () => {
    expect(words("target is eu-west-2 via retry_policy")).toEqual(["target", "is", "eu-west-2", "via", "retry_policy"]);
  });

  test("non-ascii letters are word characters, not boundaries", () => {
    expect(words("naïve café Ünicode")).toEqual(["naïve", "café", "ünicode"]);
  });

  test("empty string yields no words", () => {
    expect(words("")).toEqual([]);
  });

  test("numbers are words", () => {
    expect(words("batch of 32 items")).toEqual(["batch", "of", "32", "items"]);
  });
});

describe("sentences", () => {
  test("splits on terminator followed by whitespace", () => {
    expect(sentences("one is here. two is here! three?")).toEqual(["one is here.", "two is here!", "three?"]);
  });

  test("a terminator run stays with its sentence", () => {
    expect(sentences("really... yes. done")).toEqual(["really...", "yes.", "done"]);
  });

  test("text without a terminator is one sentence", () => {
    expect(sentences("no punctuation here at all")).toEqual(["no punctuation here at all"]);
  });

  test("a decimal number does not split", () => {
    expect(sentences("the budget is 3.75 percent. next.")).toEqual(["the budget is 3.75 percent.", "next."]);
  });

  test("empty and whitespace-only inputs yield nothing", () => {
    expect(sentences("")).toEqual([]);
    expect(sentences("   ")).toEqual([]);
  });

  test("unicode text survives", () => {
    expect(sentences("naïve plan worked. café is open.")).toEqual(["naïve plan worked.", "café is open."]);
  });
});

describe("stopwords", () => {
  test("common function words are stopwords, content words are not", () => {
    expect(STOPWORDS.has("the")).toBe(true);
    expect(STOPWORDS.has("would")).toBe(true);
    expect(STOPWORDS.has("deploy")).toBe(false);
    expect(STOPWORDS.has("target")).toBe(false);
  });
});
