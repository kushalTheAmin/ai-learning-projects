"""Loads 03-hybrid-search's corpus and golden queries, plus the authored
hypothetical answers committed in this project.

The corpus and queries are 03's committed dataset, reused as data: 100 ops
docs, 40 queries labeled keyword or paraphrase with relevant-doc ids. The
hypothetical answers are this project's dataset: one authored answer per
query, written from the question text alone, standing in for what a
knowledgeable model would generate in a HyDE step.
"""

import json
from dataclasses import dataclass
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
CORPUS_PATH = _REPO_ROOT / "03-hybrid-search" / "data" / "corpus.json"
QUERIES_PATH = _REPO_ROOT / "03-hybrid-search" / "data" / "queries.json"
HYPOTHETICALS_PATH = Path(__file__).resolve().parents[1] / "data" / "hypotheticals.json"

CATEGORIES = ("keyword", "paraphrase")


@dataclass(frozen=True)
class Query:
    query_id: str
    text: str
    relevant: tuple[str, ...]
    category: str


def load_corpus(path: Path = CORPUS_PATH) -> dict[str, str]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, list) or not raw:
        raise ValueError(f"corpus at {path} must be a non-empty list")
    docs: dict[str, str] = {}
    for entry in raw:
        doc_id, text = entry["id"], entry["text"]
        if doc_id in docs:
            raise ValueError(f"duplicate doc id {doc_id!r}")
        if not text.strip():
            raise ValueError(f"doc {doc_id!r} has empty text")
        docs[doc_id] = text
    return docs


def load_queries(path: Path = QUERIES_PATH) -> list[Query]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, list) or not raw:
        raise ValueError(f"queries at {path} must be a non-empty list")
    queries: list[Query] = []
    seen: set[str] = set()
    for entry in raw:
        query = Query(
            query_id=entry["id"],
            text=entry["query"],
            relevant=tuple(entry["relevant"]),
            category=entry["category"],
        )
        if query.query_id in seen:
            raise ValueError(f"duplicate query id {query.query_id!r}")
        seen.add(query.query_id)
        if not query.text.strip():
            raise ValueError(f"query {query.query_id!r} has empty text")
        if not query.relevant:
            raise ValueError(f"query {query.query_id!r} has no relevant docs")
        if query.category not in CATEGORIES:
            raise ValueError(
                f"query {query.query_id!r} has category {query.category!r}, "
                f"expected one of {CATEGORIES}"
            )
        queries.append(query)
    return queries


def load_hypotheticals(path: Path = HYPOTHETICALS_PATH) -> dict[str, str]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or not raw:
        raise ValueError(f"hypotheticals at {path} must be a non-empty object")
    for query_id, text in raw.items():
        if not isinstance(text, str) or not text.strip():
            raise ValueError(f"hypothetical for {query_id!r} is empty")
    return raw


def validate(
    docs: dict[str, str], queries: list[Query], hypotheticals: dict[str, str]
) -> None:
    """Cross-file consistency: every label resolves, every query has exactly
    one authored hypothetical, and no hypothetical is a corpus doc verbatim
    (the authored answers must stand in for generation, not retrieval)."""
    for query in queries:
        missing = [doc_id for doc_id in query.relevant if doc_id not in docs]
        if missing:
            raise ValueError(f"query {query.query_id!r} references unknown docs {missing}")
    query_ids = {query.query_id for query in queries}
    if set(hypotheticals) != query_ids:
        extra = sorted(set(hypotheticals) - query_ids)
        absent = sorted(query_ids - set(hypotheticals))
        raise ValueError(
            f"hypotheticals must cover the query set exactly; extra {extra}, missing {absent}"
        )
    doc_texts = set(docs.values())
    for query_id, text in hypotheticals.items():
        if text in doc_texts:
            raise ValueError(f"hypothetical for {query_id!r} copies a corpus doc verbatim")
