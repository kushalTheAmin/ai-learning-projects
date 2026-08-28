from pathlib import Path

import pytest

from neardup.corpus import (
    all_pairs,
    build_corpus,
    load_base_docs,
    pair_key,
    true_duplicate_pairs,
)
from neardup.mutations import MUTATIONS

DATA_PATH = Path(__file__).parent.parent / "data" / "docs.jsonl"


class TestLoadBaseDocs:
    def test_committed_corpus(self):
        docs = load_base_docs(DATA_PATH)
        assert len(docs) == 24
        assert all(d.kind == "base" for d in docs)
        assert len({d.doc_id for d in docs}) == 24

    def test_topic_is_loaded(self):
        by_id = {d.doc_id: d for d in load_base_docs(DATA_PATH)}
        assert by_id["cache-01"].topic == "caching"
        assert by_id["ratelimit-03"].topic == "rate limiting"

    def test_empty_file_raises(self, tmp_path):
        empty = tmp_path / "empty.jsonl"
        empty.write_text("\n\n", encoding="utf-8")
        with pytest.raises(ValueError):
            load_base_docs(empty)

    def test_duplicate_id_raises(self, tmp_path):
        bad = tmp_path / "bad.jsonl"
        bad.write_text(
            '{"doc_id": "x", "topic": "t", "text": "a"}\n'
            '{"doc_id": "x", "topic": "t", "text": "b"}\n',
            encoding="utf-8",
        )
        with pytest.raises(ValueError):
            load_base_docs(bad)


class TestBuildCorpus:
    def test_size_and_kinds(self):
        base = load_base_docs(DATA_PATH)
        corpus = build_corpus(base, seed=42)
        assert len(corpus) == 24 * (1 + len(MUTATIONS))
        kinds = {d.kind for d in corpus}
        assert kinds == {"base", *MUTATIONS.keys()}

    def test_deterministic_for_seed(self):
        base = load_base_docs(DATA_PATH)
        a = build_corpus(base, seed=42)
        b = build_corpus(base, seed=42)
        assert [(d.doc_id, d.text) for d in a] == [(d.doc_id, d.text) for d in b]

    def test_seed_changes_mutants(self):
        base = load_base_docs(DATA_PATH)
        a = {d.doc_id: d.text for d in build_corpus(base, seed=42)}
        b = {d.doc_id: d.text for d in build_corpus(base, seed=43)}
        assert any(a[k] != b[k] for k in a)

    def test_mutants_keep_group(self):
        base = load_base_docs(DATA_PATH)
        for d in build_corpus(base, seed=42):
            assert d.doc_id.startswith(d.group)

    def test_mutants_keep_topic(self):
        base = load_base_docs(DATA_PATH)
        topics = {d.doc_id: d.topic for d in base}
        for d in build_corpus(base, seed=42):
            assert d.topic == topics[d.group]


class TestPairs:
    def test_pair_key_orders(self):
        assert pair_key("b", "a") == ("a", "b")
        assert pair_key("a", "b") == ("a", "b")

    def test_counts_on_committed_corpus(self):
        base = load_base_docs(DATA_PATH)
        corpus = build_corpus(base, seed=42)
        n = len(corpus)
        assert len(all_pairs(corpus)) == n * (n - 1) // 2
        # each group has 6 members -> C(6,2) = 15 duplicate pairs
        assert len(true_duplicate_pairs(corpus)) == 24 * 15

    def test_truth_pairs_stay_within_groups(self):
        base = load_base_docs(DATA_PATH)
        corpus = build_corpus(base, seed=42)
        by_id = {d.doc_id: d for d in corpus}
        for a, b in true_duplicate_pairs(corpus):
            assert by_id[a].group == by_id[b].group
