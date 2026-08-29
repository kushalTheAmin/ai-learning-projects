import json
from pathlib import Path

import pytest

from multihop.data import Query, load_corpus, load_queries, validate


def write_jsonl(path: Path, records: list[dict]) -> Path:
    path.write_text("\n".join(json.dumps(r) for r in records) + "\n", encoding="utf-8")
    return path


def test_committed_dataset_loads_and_validates() -> None:
    docs = load_corpus()
    queries = load_queries()
    validate(docs, queries)
    assert len(docs) == 28
    kinds = [q.kind for q in queries]
    assert kinds.count("two-hop") == 24
    assert kinds.count("single-hop") == 8


def test_duplicate_doc_id_raises(tmp_path: Path) -> None:
    path = write_jsonl(
        tmp_path / "corpus.jsonl",
        [
            {"id": "a", "title": "t", "text": "x"},
            {"id": "a", "title": "t", "text": "y"},
        ],
    )
    with pytest.raises(ValueError, match="duplicate doc id"):
        load_corpus(path)


def test_empty_corpus_raises(tmp_path: Path) -> None:
    path = tmp_path / "corpus.jsonl"
    path.write_text("", encoding="utf-8")
    with pytest.raises(ValueError, match="no documents"):
        load_corpus(path)


def test_duplicate_query_id_raises(tmp_path: Path) -> None:
    record = {"id": "q", "kind": "single-hop", "question": "x", "answer_id": "a"}
    path = write_jsonl(tmp_path / "queries.jsonl", [record, record])
    with pytest.raises(ValueError, match="duplicate query id"):
        load_queries(path)


def test_unknown_kind_raises(tmp_path: Path) -> None:
    path = write_jsonl(
        tmp_path / "queries.jsonl",
        [{"id": "q", "kind": "three-hop", "question": "x", "answer_id": "a"}],
    )
    with pytest.raises(ValueError, match="unknown kind"):
        load_queries(path)


DOCS = {"resp": "the wobble service owns billing", "infra": "wobble uses maindb"}


def two_hop_query(**overrides) -> Query:
    fields = dict(
        id="q",
        question="which db backs billing",
        kind="two-hop",
        answer_id="infra",
        hop1_id="resp",
        bridge=("wobble",),
    )
    fields.update(overrides)
    return Query(**fields)


def test_validate_accepts_wellformed() -> None:
    validate(DOCS, [two_hop_query()])


def test_validate_missing_answer_doc() -> None:
    with pytest.raises(ValueError, match="not in corpus"):
        validate(DOCS, [two_hop_query(answer_id="ghost")])


def test_validate_hop1_equals_answer() -> None:
    with pytest.raises(ValueError, match="equals answer"):
        validate(DOCS, [two_hop_query(hop1_id="infra")])


def test_validate_bridge_missing_from_doc() -> None:
    with pytest.raises(ValueError, match="missing from"):
        validate(DOCS, [two_hop_query(bridge=("billing",))])  # not in infra doc


def test_validate_bridge_leaked_into_question() -> None:
    with pytest.raises(ValueError, match="already in the question"):
        validate(DOCS, [two_hop_query(question="which db backs wobble billing")])


def test_validate_bridge_must_be_casefolded() -> None:
    with pytest.raises(ValueError, match="not casefolded"):
        validate(DOCS, [two_hop_query(bridge=("Wobble",))])


def test_validate_two_hop_needs_bridge() -> None:
    with pytest.raises(ValueError, match="need hop1_id and bridge"):
        validate(DOCS, [two_hop_query(bridge=())])


def test_validate_single_hop_must_not_carry_bridge() -> None:
    query = Query(
        id="q",
        question="x",
        kind="single-hop",
        answer_id="infra",
        hop1_id="resp",
    )
    with pytest.raises(ValueError, match="carry no hop1/bridge"):
        validate(DOCS, [query])
