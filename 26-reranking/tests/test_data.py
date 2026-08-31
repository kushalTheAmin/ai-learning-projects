import json

import pytest

from reranking.data import CATEGORIES, load_corpus, load_queries, validate_relevance


def test_corpus_loads_100_unique_docs(docs):
    assert len(docs) == 100
    assert len({d.doc_id for d in docs}) == 100
    assert all(d.text.strip() for d in docs)


def test_queries_load_40_with_valid_categories(queries):
    assert len(queries) == 40
    assert len({q.query_id for q in queries}) == 40
    assert all(q.category in CATEGORIES for q in queries)
    by_category = {c: sum(1 for q in queries if q.category == c) for c in CATEGORIES}
    assert by_category == {"keyword": 20, "paraphrase": 20}


def test_every_relevant_doc_exists(docs, queries):
    validate_relevance(docs, queries)  # raises on a dangling reference


def _write(path, payload):
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def test_duplicate_doc_id_rejected(tmp_path):
    path = _write(
        tmp_path / "corpus.json",
        [{"id": "a", "text": "one"}, {"id": "a", "text": "two"}],
    )
    with pytest.raises(ValueError, match="duplicate doc id"):
        load_corpus(path)


def test_empty_doc_text_rejected(tmp_path):
    path = _write(tmp_path / "corpus.json", [{"id": "a", "text": "   "}])
    with pytest.raises(ValueError, match="empty text"):
        load_corpus(path)


def test_empty_corpus_rejected(tmp_path):
    path = _write(tmp_path / "corpus.json", [])
    with pytest.raises(ValueError, match="non-empty"):
        load_corpus(path)


def test_unknown_category_rejected(tmp_path):
    path = _write(
        tmp_path / "queries.json",
        [{"id": "q1", "query": "x", "relevant": ["a"], "category": "nope"}],
    )
    with pytest.raises(ValueError, match="unknown category"):
        load_queries(path)


def test_query_without_relevant_docs_rejected(tmp_path):
    path = _write(
        tmp_path / "queries.json",
        [{"id": "q1", "query": "x", "relevant": [], "category": "keyword"}],
    )
    with pytest.raises(ValueError, match="no relevant docs"):
        load_queries(path)


def test_dangling_relevance_rejected(docs, queries):
    from reranking.data import Query

    bad = list(queries) + [
        Query(query_id="zz", text="x", relevant=("no-such-doc",), category="keyword")
    ]
    with pytest.raises(ValueError, match="unknown docs"):
        validate_relevance(docs, bad)
