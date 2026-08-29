import { describe, expect, it } from "vitest";
import { loadDocs, loadQueries, validateDocs, validateQueries, type Doc } from "../src/data.js";

const DOC: Doc = { id: "d1", title: "t", text: "The backup runs nightly. Restores are drilled monthly." };

describe("loadDocs", () => {
  it("loads the committed corpus", () => {
    const docs = loadDocs();
    expect(docs).toHaveLength(10);
    expect(docs.map((d) => d.id)).toContain("pg-backups");
  });

  it("rejects a line that is not valid json", () => {
    expect(() => loadDocs('{"id": "a", "title": "t", "text": "x"}\n{nope')).toThrow("line 2: not valid json");
  });

  it("rejects a line that is not an object", () => {
    expect(() => loadDocs('["not", "an", "object"]')).toThrow("not an object");
  });

  it("rejects a missing field", () => {
    expect(() => loadDocs('{"id": "a", "title": "t"}')).toThrow('field "text" must be a non-empty string');
  });

  it("rejects an empty corpus", () => {
    expect(() => loadDocs("\n\n")).toThrow("no docs");
  });

  it("rejects duplicate doc ids", () => {
    const line = '{"id": "a", "title": "t", "text": "x"}';
    expect(() => loadDocs(`${line}\n${line}`)).toThrow('duplicate doc id "a"');
  });
});

describe("loadQueries", () => {
  it("loads the committed golden set and every answer is verbatim in its doc", () => {
    const docs = loadDocs();
    const queries = loadQueries(docs);
    expect(queries).toHaveLength(40);
    const categories = new Set(queries.map((q) => q.category));
    expect(categories).toEqual(new Set(["keyword", "paraphrase"]));
  });

  it("rejects a query referencing an unknown doc", () => {
    const row = '{"id": "q1", "query": "x", "doc_id": "ghost", "answer": "y", "category": "keyword"}';
    expect(() => loadQueries([DOC], row)).toThrow('references unknown doc "ghost"');
  });

  it("rejects an answer that is not a verbatim substring", () => {
    const row = '{"id": "q1", "query": "x", "doc_id": "d1", "answer": "backup runs weekly", "category": "keyword"}';
    expect(() => loadQueries([DOC], row)).toThrow("not a verbatim substring");
  });

  it("accepts an answer that is a verbatim substring", () => {
    const row = '{"id": "q1", "query": "x", "doc_id": "d1", "answer": "The backup runs nightly.", "category": "keyword"}';
    expect(loadQueries([DOC], row)).toHaveLength(1);
  });

  it("rejects duplicate query ids", () => {
    const row = '{"id": "q1", "query": "x", "doc_id": "d1", "answer": "The backup runs nightly.", "category": "keyword"}';
    expect(() => loadQueries([DOC], `${row}\n${row}`)).toThrow('duplicate query id "q1"');
  });
});

describe("validators", () => {
  it("validateDocs rejects an empty list", () => {
    expect(() => validateDocs([])).toThrow("no docs");
  });

  it("validateQueries rejects an empty list", () => {
    expect(() => validateQueries([], [DOC])).toThrow("no queries");
  });
});
