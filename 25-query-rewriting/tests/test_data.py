import json

import pytest

from query_rewriting.data import (
    Query,
    load_corpus,
    load_hypotheticals,
    load_queries,
    validate,
)


def test_committed_dataset_loads_and_validates():
    docs = load_corpus()
    queries = load_queries()
    hypotheticals = load_hypotheticals()
    validate(docs, queries, hypotheticals)
    assert len(docs) == 100
    assert len(queries) == 40
    assert len([q for q in queries if q.category == "keyword"]) == 20
    assert len([q for q in queries if q.category == "paraphrase"]) == 20
    assert set(hypotheticals) == {q.query_id for q in queries}


def test_every_hypothetical_is_authored_prose_not_a_corpus_doc():
    docs = load_corpus()
    hypotheticals = load_hypotheticals()
    doc_texts = set(docs.values())
    for text in hypotheticals.values():
        assert text not in doc_texts
        assert len(text) > 40


def test_corpus_rejects_duplicate_ids(tmp_path):
    path = tmp_path / "corpus.json"
    path.write_text(json.dumps([
        {"id": "a", "text": "one"},
        {"id": "a", "text": "two"},
    ]))
    with pytest.raises(ValueError, match="duplicate doc id"):
        load_corpus(path)


def test_corpus_rejects_empty_text(tmp_path):
    path = tmp_path / "corpus.json"
    path.write_text(json.dumps([{"id": "a", "text": "   "}]))
    with pytest.raises(ValueError, match="empty text"):
        load_corpus(path)


def test_corpus_rejects_non_list(tmp_path):
    path = tmp_path / "corpus.json"
    path.write_text(json.dumps({"id": "a"}))
    with pytest.raises(ValueError, match="non-empty list"):
        load_corpus(path)


def test_queries_reject_unknown_category(tmp_path):
    path = tmp_path / "queries.json"
    path.write_text(json.dumps([
        {"id": "q1", "query": "hello", "relevant": ["a"], "category": "vibes"},
    ]))
    with pytest.raises(ValueError, match="category"):
        load_queries(path)


def test_queries_reject_empty_relevant(tmp_path):
    path = tmp_path / "queries.json"
    path.write_text(json.dumps([
        {"id": "q1", "query": "hello", "relevant": [], "category": "keyword"},
    ]))
    with pytest.raises(ValueError, match="no relevant docs"):
        load_queries(path)


def test_validate_rejects_unknown_relevant_doc():
    docs = {"a": "text"}
    queries = [Query("q1", "hello", ("missing",), "keyword")]
    with pytest.raises(ValueError, match="unknown docs"):
        validate(docs, queries, {"q1": "an answer"})


def test_validate_rejects_hypothetical_set_mismatch():
    docs = {"a": "text"}
    queries = [Query("q1", "hello", ("a",), "keyword")]
    with pytest.raises(ValueError, match="cover the query set exactly"):
        validate(docs, queries, {"q1": "an answer", "q2": "extra"})


def test_validate_rejects_verbatim_doc_copy():
    docs = {"a": "the exact document text"}
    queries = [Query("q1", "hello", ("a",), "keyword")]
    with pytest.raises(ValueError, match="copies a corpus doc"):
        validate(docs, queries, {"q1": "the exact document text"})
