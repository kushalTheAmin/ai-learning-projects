import { describe, expect, it } from "vitest";
import { loadDocs, loadQueries, type Doc } from "../src/data.js";
import { DocIndex } from "../src/retrieval.js";

const TOY: Doc[] = [
  { id: "cats", title: "cats", text: "cats purr and cats nap on warm windowsills all afternoon" },
  { id: "dogs", title: "dogs", text: "dogs bark and dogs fetch sticks in the park every morning" },
  { id: "fish", title: "fish", text: "fish swim in the tank and fish eat flakes twice a day" },
];

describe("DocIndex.topK", () => {
  it("ranks the doc sharing the question's words first", () => {
    const index = new DocIndex(TOY);
    const top = index.topK("why do cats purr", 3);
    expect(top[0]?.doc.id).toBe("cats");
    expect(top[0]!.score).toBeGreaterThan(top[1]!.score);
  });

  it("retrieves the gold doc first for a keyword golden query", () => {
    const docs = loadDocs();
    const queries = loadQueries(docs);
    const q01 = queries.find((q) => q.id === "q01");
    expect(q01).toBeDefined();
    const top = new DocIndex(docs).topK(q01!.query, 1);
    expect(top[0]?.doc.id).toBe(q01!.docId);
  });

  it("breaks score ties by doc id", () => {
    const twin = { title: "same", text: "identical text about turtles" };
    const index = new DocIndex([
      { id: "b-doc", ...twin },
      { id: "a-doc", ...twin },
    ]);
    const top = index.topK("turtles", 2);
    expect(top[0]?.score).toBe(top[1]?.score);
    expect(top.map((r) => r.doc.id)).toEqual(["a-doc", "b-doc"]);
  });

  it("returns all docs when k exceeds the corpus", () => {
    expect(new DocIndex(TOY).topK("cats", 50)).toHaveLength(3);
  });

  it("rejects non-positive and non-integer k", () => {
    const index = new DocIndex(TOY);
    expect(() => index.topK("cats", 0)).toThrow(RangeError);
    expect(() => index.topK("cats", -1)).toThrow(RangeError);
    expect(() => index.topK("cats", 1.5)).toThrow(RangeError);
  });

  it("scores an unknown-vocabulary question 0 everywhere and returns id order", () => {
    const index = new DocIndex(TOY);
    const top = index.topK("zzz qqq", 3);
    expect(top.every((r) => r.score === 0)).toBe(true);
    expect(top.map((r) => r.doc.id)).toEqual(["cats", "dogs", "fish"]);
  });

  it("handles a unicode question without crashing", () => {
    const top = new DocIndex(TOY).topK("où nagent les poissons 魚", 2);
    expect(top).toHaveLength(2);
  });
});
