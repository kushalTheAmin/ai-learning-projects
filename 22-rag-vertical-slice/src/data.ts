/**
 * Doc set and golden queries, loaded from 10-chunking-strategies' committed
 * corpus: 10 authored ops runbooks and 40 queries whose gold answer is a
 * verbatim sentence of its gold doc. The same file serves as the retrieval
 * corpus and as the endpoint's eval set, so the data is validated hard at
 * load: any missing field, duplicate id, dangling doc reference, or answer
 * that is not an exact substring of its doc is a thrown error, not a quiet
 * zero in a metric downstream.
 */

import { readFileSync } from "node:fs";

export interface Doc {
  id: string;
  title: string;
  text: string;
}

export interface GoldenQuery {
  id: string;
  query: string;
  docId: string;
  answer: string;
  category: string;
}

const CORPUS_URL = new URL("../../10-chunking-strategies/data/corpus.jsonl", import.meta.url);
const QUERIES_URL = new URL("../../10-chunking-strategies/data/queries.jsonl", import.meta.url);

function parseJsonl(raw: string, label: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const [index, line] of raw.split("\n").entries()) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`${label} line ${index + 1}: not valid json`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${label} line ${index + 1}: not an object`);
    }
    rows.push(parsed as Record<string, unknown>);
  }
  return rows;
}

function requireString(row: Record<string, unknown>, field: string, label: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label}: field "${field}" must be a non-empty string`);
  }
  return value;
}

export function validateDocs(docs: readonly Doc[]): void {
  if (docs.length === 0) throw new Error("corpus: no docs");
  const seen = new Set<string>();
  for (const doc of docs) {
    if (seen.has(doc.id)) throw new Error(`corpus: duplicate doc id "${doc.id}"`);
    seen.add(doc.id);
  }
}

export function validateQueries(queries: readonly GoldenQuery[], docs: readonly Doc[]): void {
  if (queries.length === 0) throw new Error("queries: no queries");
  const byId = new Map(docs.map((doc) => [doc.id, doc]));
  const seen = new Set<string>();
  for (const query of queries) {
    if (seen.has(query.id)) throw new Error(`queries: duplicate query id "${query.id}"`);
    seen.add(query.id);
    const doc = byId.get(query.docId);
    if (doc === undefined) {
      throw new Error(`queries: ${query.id} references unknown doc "${query.docId}"`);
    }
    if (!doc.text.includes(query.answer)) {
      throw new Error(`queries: ${query.id} answer is not a verbatim substring of ${query.docId}`);
    }
  }
}

export function loadDocs(raw = readFileSync(CORPUS_URL, "utf-8")): Doc[] {
  const docs = parseJsonl(raw, "corpus").map((row, index) => ({
    id: requireString(row, "id", `corpus row ${index + 1}`),
    title: requireString(row, "title", `corpus row ${index + 1}`),
    text: requireString(row, "text", `corpus row ${index + 1}`),
  }));
  validateDocs(docs);
  return docs;
}

export function loadQueries(docs: readonly Doc[], raw = readFileSync(QUERIES_URL, "utf-8")): GoldenQuery[] {
  const queries = parseJsonl(raw, "queries").map((row, index) => ({
    id: requireString(row, "id", `queries row ${index + 1}`),
    query: requireString(row, "query", `queries row ${index + 1}`),
    docId: requireString(row, "doc_id", `queries row ${index + 1}`),
    answer: requireString(row, "answer", `queries row ${index + 1}`),
    category: requireString(row, "category", `queries row ${index + 1}`),
  }));
  validateQueries(queries, docs);
  return queries;
}
