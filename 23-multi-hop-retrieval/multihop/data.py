"""Loading and validating the committed corpus and query set."""

import json
from dataclasses import dataclass, field
from pathlib import Path

from .reuse import tokenize

DATA_DIR = Path(__file__).resolve().parents[1] / "data"


@dataclass(frozen=True)
class Query:
    id: str
    question: str
    kind: str  # "two-hop" or "single-hop"
    answer_id: str
    hop1_id: str | None = None  # two-hop only: the doc naming the bridge
    bridge: tuple[str, ...] = field(default=())  # two-hop only: gold bridge tokens


def load_corpus(path: Path = DATA_DIR / "corpus.jsonl") -> dict[str, str]:
    docs: dict[str, str] = {}
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            record = json.loads(line)
            doc_id = record["id"]
            if doc_id in docs:
                raise ValueError(f"duplicate doc id {doc_id!r}")
            docs[doc_id] = f"{record['title']}\n{record['text']}"
    if not docs:
        raise ValueError(f"no documents in {path}")
    return docs


def load_queries(path: Path = DATA_DIR / "queries.jsonl") -> list[Query]:
    queries = []
    seen: set[str] = set()
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            record = json.loads(line)
            query = Query(
                id=record["id"],
                question=record["question"],
                kind=record["kind"],
                answer_id=record["answer_id"],
                hop1_id=record.get("hop1_id"),
                bridge=tuple(record.get("bridge", [])),
            )
            if query.id in seen:
                raise ValueError(f"duplicate query id {query.id!r}")
            seen.add(query.id)
            if query.kind not in ("two-hop", "single-hop"):
                raise ValueError(f"{query.id}: unknown kind {query.kind!r}")
            queries.append(query)
    if not queries:
        raise ValueError(f"no queries in {path}")
    return queries


def validate(docs: dict[str, str], queries: list[Query]) -> None:
    """Structural checks the eval quietly depends on.

    A two-hop query must name a hop1 doc distinct from its answer doc, its
    gold bridge tokens must actually occur in both docs (otherwise the hop
    is not followable even in principle), and the bridge must not already
    appear in the question (otherwise the query is single-hop in disguise).
    """
    for query in queries:
        if query.answer_id not in docs:
            raise ValueError(f"{query.id}: answer doc {query.answer_id!r} not in corpus")
        if query.kind == "single-hop":
            if query.hop1_id is not None or query.bridge:
                raise ValueError(f"{query.id}: single-hop queries carry no hop1/bridge")
            continue
        if query.hop1_id is None or not query.bridge:
            raise ValueError(f"{query.id}: two-hop queries need hop1_id and bridge")
        if query.hop1_id not in docs:
            raise ValueError(f"{query.id}: hop1 doc {query.hop1_id!r} not in corpus")
        if query.hop1_id == query.answer_id:
            raise ValueError(f"{query.id}: hop1 doc equals answer doc")
        question_terms = set(tokenize(query.question))
        for token in query.bridge:
            if token != token.casefold():
                raise ValueError(f"{query.id}: bridge token {token!r} not casefolded")
            for doc_id in (query.hop1_id, query.answer_id):
                if token not in tokenize(docs[doc_id]):
                    raise ValueError(
                        f"{query.id}: bridge token {token!r} missing from {doc_id!r}"
                    )
            if token in question_terms:
                raise ValueError(
                    f"{query.id}: bridge token {token!r} already in the question"
                )
