"""Loads 03-hybrid-search's committed corpus and golden queries.

No new dataset: the whole point of a reranking measurement is holding the
document set, the queries and the relevance labels fixed while only the
ordering machinery changes. 03's data is 100 ops/git/http docs and 40
queries labeled keyword or paraphrase with relevant-doc ids.
"""

import json
from dataclasses import dataclass
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
CORPUS_PATH = _REPO_ROOT / "03-hybrid-search" / "data" / "corpus.json"
QUERIES_PATH = _REPO_ROOT / "03-hybrid-search" / "data" / "queries.json"

CATEGORIES = ("keyword", "paraphrase")


@dataclass(frozen=True)
class Document:
    doc_id: str
    text: str


@dataclass(frozen=True)
class Query:
    query_id: str
    text: str
    relevant: tuple[str, ...]
    category: str


def load_corpus(path: Path = CORPUS_PATH) -> list[Document]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, list) or not raw:
        raise ValueError(f"corpus at {path} must be a non-empty list")
    seen: set[str] = set()
    docs: list[Document] = []
    for entry in raw:
        doc_id, text = entry["id"], entry["text"]
        if doc_id in seen:
            raise ValueError(f"duplicate doc id {doc_id!r}")
        if not text.strip():
            raise ValueError(f"doc {doc_id!r} has empty text")
        seen.add(doc_id)
        docs.append(Document(doc_id=doc_id, text=text))
    return docs


def load_queries(path: Path = QUERIES_PATH) -> list[Query]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, list) or not raw:
        raise ValueError(f"queries at {path} must be a non-empty list")
    seen: set[str] = set()
    queries: list[Query] = []
    for entry in raw:
        query_id, category = entry["id"], entry["category"]
        if query_id in seen:
            raise ValueError(f"duplicate query id {query_id!r}")
        if category not in CATEGORIES:
            raise ValueError(f"query {query_id!r} has unknown category {category!r}")
        if not entry["relevant"]:
            raise ValueError(f"query {query_id!r} has no relevant docs")
        seen.add(query_id)
        queries.append(
            Query(
                query_id=query_id,
                text=entry["query"],
                relevant=tuple(entry["relevant"]),
                category=category,
            )
        )
    return queries


def validate_relevance(docs: list[Document], queries: list[Query]) -> None:
    doc_ids = {d.doc_id for d in docs}
    for query in queries:
        missing = [r for r in query.relevant if r not in doc_ids]
        if missing:
            raise ValueError(
                f"query {query.query_id!r} references unknown docs {missing}"
            )
