import json
from pathlib import Path

import pytest

from chunking.corpus import Doc, Query, load_docs, load_queries, validate

DATA = Path(__file__).parent.parent / "data"


def write_jsonl(path, records):
    path.write_text("\n".join(json.dumps(r) for r in records) + "\n", encoding="utf-8")


class TestCommittedData:
    def test_loads(self):
        docs = load_docs(DATA / "corpus.jsonl")
        queries = load_queries(DATA / "queries.jsonl")
        assert len(docs) == 10
        assert len(queries) == 40

    def test_ground_truth_is_unambiguous(self):
        docs = load_docs(DATA / "corpus.jsonl")
        queries = load_queries(DATA / "queries.jsonl")
        validate(docs, queries)  # raises on any missing or duplicated answer

    def test_every_doc_has_queries(self):
        docs = load_docs(DATA / "corpus.jsonl")
        queries = load_queries(DATA / "queries.jsonl")
        queried = {q.doc_id for q in queries}
        assert queried == {d.id for d in docs}

    def test_categories_are_balanced(self):
        queries = load_queries(DATA / "queries.jsonl")
        keyword = sum(q.category == "keyword" for q in queries)
        assert keyword == 20
        assert len(queries) - keyword == 20


class TestValidation:
    def docs(self):
        return [
            Doc(id="a", title="A", text="The rate limit is 100 requests. More text here."),
            Doc(id="b", title="B", text="Completely different content about certificates."),
        ]

    def test_accepts_clean_data(self):
        queries = [
            Query(
                id="q1",
                query="what is the limit",
                doc_id="a",
                answer="The rate limit is 100 requests.",
                category="keyword",
            )
        ]
        validate(self.docs(), queries)

    def test_rejects_answer_not_in_doc(self):
        queries = [
            Query(id="q1", query="x", doc_id="a", answer="not present", category="keyword")
        ]
        with pytest.raises(ValueError, match="occurs 0 times"):
            validate(self.docs(), queries)

    def test_rejects_answer_appearing_twice(self):
        docs = [Doc(id="a", title="A", text="Same phrase here. Same phrase here.")]
        queries = [
            Query(id="q1", query="x", doc_id="a", answer="Same phrase here.", category="keyword")
        ]
        with pytest.raises(ValueError, match="occurs 2 times"):
            validate(docs, queries)

    def test_rejects_answer_present_in_other_doc(self):
        docs = self.docs() + [Doc(id="c", title="C", text="The rate limit is 100 requests.")]
        queries = [
            Query(
                id="q1",
                query="x",
                doc_id="a",
                answer="The rate limit is 100 requests.",
                category="keyword",
            )
        ]
        with pytest.raises(ValueError, match="also occurs in c"):
            validate(docs, queries)

    def test_rejects_unknown_doc(self):
        queries = [
            Query(id="q1", query="x", doc_id="nope", answer="y", category="keyword")
        ]
        with pytest.raises(ValueError, match="unknown doc"):
            validate(self.docs(), queries)


class TestLoading:
    def test_rejects_duplicate_doc_ids(self, tmp_path):
        path = tmp_path / "corpus.jsonl"
        write_jsonl(
            path,
            [
                {"id": "a", "title": "A", "text": "One."},
                {"id": "a", "title": "A2", "text": "Two."},
            ],
        )
        with pytest.raises(ValueError, match="duplicate doc ids"):
            load_docs(path)

    def test_rejects_duplicate_query_ids(self, tmp_path):
        path = tmp_path / "queries.jsonl"
        record = {"id": "q1", "query": "x", "doc_id": "a", "answer": "y", "category": "keyword"}
        write_jsonl(path, [record, record])
        with pytest.raises(ValueError, match="duplicate query ids"):
            load_queries(path)

    def test_rejects_unknown_category(self, tmp_path):
        path = tmp_path / "queries.jsonl"
        write_jsonl(
            path,
            [{"id": "q1", "query": "x", "doc_id": "a", "answer": "y", "category": "vibes"}],
        )
        with pytest.raises(ValueError, match="unknown category"):
            load_queries(path)

    def test_rejects_empty_file(self, tmp_path):
        path = tmp_path / "corpus.jsonl"
        path.write_text("\n", encoding="utf-8")
        with pytest.raises(ValueError, match="is empty"):
            load_docs(path)
