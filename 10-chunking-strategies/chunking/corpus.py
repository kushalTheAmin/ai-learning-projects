"""Loading and validating the committed corpus and gold queries.

Ground truth is an exact answer string: each query names the document it
comes from and the one sentence that answers it, verbatim. Validation
insists the answer occurs exactly once in that document and nowhere else
in the corpus, so "a chunk contains the answer" is unambiguous.
"""

import json
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Doc:
    id: str
    title: str
    text: str


@dataclass(frozen=True)
class Query:
    id: str
    query: str
    doc_id: str
    answer: str
    category: str  # "keyword" or "paraphrase"


def load_docs(path: Path) -> list[Doc]:
    docs = [Doc(**record) for record in _read_jsonl(path)]
    if len({d.id for d in docs}) != len(docs):
        raise ValueError("duplicate doc ids in corpus")
    return docs


def load_queries(path: Path) -> list[Query]:
    queries = [Query(**record) for record in _read_jsonl(path)]
    if len({q.id for q in queries}) != len(queries):
        raise ValueError("duplicate query ids")
    for q in queries:
        if q.category not in ("keyword", "paraphrase"):
            raise ValueError(f"{q.id}: unknown category {q.category!r}")
    return queries


def validate(docs: list[Doc], queries: list[Query]) -> None:
    """Raise if any query's ground truth is missing or ambiguous."""
    by_id = {d.id: d for d in docs}
    for q in queries:
        home = by_id.get(q.doc_id)
        if home is None:
            raise ValueError(f"{q.id}: unknown doc {q.doc_id}")
        occurrences = home.text.count(q.answer)
        if occurrences != 1:
            raise ValueError(
                f"{q.id}: answer occurs {occurrences} times in {q.doc_id}, expected 1"
            )
        for d in docs:
            if d.id != q.doc_id and q.answer in d.text:
                raise ValueError(f"{q.id}: answer also occurs in {d.id}")


def _read_jsonl(path: Path) -> list[dict]:
    records = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            if line.strip():
                records.append(json.loads(line))
    if not records:
        raise ValueError(f"{path} is empty")
    return records
