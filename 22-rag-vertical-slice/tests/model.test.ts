import { describe, expect, it } from "vitest";
import { loadDocs, loadQueries, type Doc } from "../src/data.js";
import {
  answerPieces,
  answerText,
  bestSentence,
  contentWords,
  MIN_OVERLAP,
  overlapScore,
  REFUSAL,
} from "../src/model.js";

const DOC: Doc = {
  id: "d1",
  title: "backups",
  text: "The nightly backup starts at midnight. Restores are drilled monthly by the oncall.",
};

describe("contentWords", () => {
  it("drops stopwords and keeps content words", () => {
    const words = contentWords("what time does the nightly backup run");
    expect(words.has("the")).toBe(false);
    expect(words.has("what")).toBe(false);
    expect(words.has("nightly")).toBe(true);
    expect(words.has("backup")).toBe(true);
  });
});

describe("overlapScore", () => {
  it("is the exact fraction of question content words in the sentence", () => {
    const question = contentWords("nightly backup midnight run");
    // sentence holds nightly, backup, midnight but not run: 3 of 4
    expect(overlapScore(question, "The nightly backup starts at midnight.")).toBe(3 / 4);
  });

  it("is 0 when the question has no content words", () => {
    expect(overlapScore(contentWords("the of and"), "The nightly backup starts at midnight.")).toBe(0);
  });

  it("does not bridge a plural mismatch", () => {
    expect(overlapScore(contentWords("backups"), "one backup ran")).toBe(0);
  });
});

describe("bestSentence and answerText", () => {
  it("extracts the sentence that answers the question", () => {
    const answer = answerText("what time does the nightly backup start", [DOC]);
    expect(answer).toBe("The nightly backup starts at midnight.");
  });

  it("answers the first golden query from its gold doc", () => {
    const docs = loadDocs();
    const queries = loadQueries(docs);
    const q01 = queries.find((q) => q.id === "q01");
    const gold = docs.find((d) => d.id === q01!.docId);
    const answer = answerText(q01!.query, [gold!]);
    expect(answer).toContain(q01!.answer);
  });

  it("refuses on an empty context", () => {
    expect(answerText("what time does the backup start", [])).toBe(REFUSAL);
  });

  it("refuses when nothing in the context clears the overlap floor", () => {
    const unrelated: Doc = { id: "d2", title: "lunch", text: "The cafeteria serves tacos on tuesdays." };
    expect(answerText("what time does the nightly backup start", [unrelated])).toBe(REFUSAL);
  });

  it("breaks overlap ties toward the earlier sentence", () => {
    const doc: Doc = { id: "d3", title: "t", text: "Alpha beta gamma first. Alpha beta gamma second." };
    const best = bestSentence("alpha beta gamma", [doc]);
    expect(best?.sentence).toBe("Alpha beta gamma first.");
    expect(best?.overlap).toBe(1);
  });

  it("keeps the floor meaningful: a sub-floor best sentence refuses", () => {
    const doc: Doc = { id: "d4", title: "t", text: "Only nightly appears here, nothing else matches at all." };
    const best = bestSentence("nightly backup restore drill schedule", [doc]);
    expect(best!.overlap).toBeLessThan(MIN_OVERLAP);
    expect(answerText("nightly backup restore drill schedule", [doc])).toBe(REFUSAL);
  });
});

describe("answerPieces", () => {
  it("rejoins to the exact answer text", () => {
    const answer = "Base backups run nightly at 02:30 UTC.";
    expect(answerPieces(answer).join("")).toBe(answer);
  });

  it("keeps internal whitespace runs with the preceding word", () => {
    expect(answerPieces("a  b\tc")).toEqual(["a  ", "b\t", "c"]);
  });

  it("handles unicode text", () => {
    const text = "café ночью 02:30 done";
    expect(answerPieces(text).join("")).toBe(text);
  });

  it("returns no pieces for an empty answer", () => {
    expect(answerPieces("")).toEqual([]);
  });
});
