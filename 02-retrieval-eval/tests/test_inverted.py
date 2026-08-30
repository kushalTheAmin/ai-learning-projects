import math
from pathlib import Path

import pytest

from retrieval_eval.bm25 import BM25Index
from retrieval_eval.data import load_corpus, load_queries
from retrieval_eval.inverted import InvertedBM25Index
from retrieval_eval.synth import generate_corpus, generate_queries

DATA_DIR = Path(__file__).parent.parent / "data"


def test_hand_computed_score_single_doc():
    # one doc, so length_norm = 1; score = idf * tf*(k1+1)/(tf + k1)
    index = InvertedBM25Index({"d1": "cat sat on the mat"}, k1=1.5, b=0.75)
    expected_idf = math.log(1 + (1 - 1 + 0.5) / (1 + 0.5))
    expected = expected_idf * (1 * 2.5) / (1 + 1.5)
    results = index.search("cat", top_k=10)
    assert results == [("d1", pytest.approx(expected))]


def test_identical_to_flat_scan_on_golden_dataset():
    # exact float equality on purpose: the two scorers must run the same
    # arithmetic in the same order, not merely agree approximately
    corpus = load_corpus(DATA_DIR / "corpus.jsonl")
    queries = load_queries(DATA_DIR / "queries.jsonl", corpus)
    flat = BM25Index(corpus)
    inverted = InvertedBM25Index(corpus)
    for query in queries:
        for top_k in (1, 10, len(corpus)):
            assert flat.search(query.text, top_k) == inverted.search(query.text, top_k)


def test_identical_to_flat_scan_on_synthetic_corpus():
    docs = generate_corpus(300, seed=5)
    flat = BM25Index(docs)
    inverted = InvertedBM25Index(docs)
    queries = [
        query
        for stratum in ("typical", "common-heavy", "rare-only")
        for query in generate_queries(20, seed=6, stratum=stratum)
    ]
    for query in queries:
        assert flat.search(query, 10) == inverted.search(query, 10)


def test_identical_when_matches_are_fewer_than_top_k():
    docs = {"d1": "apple pie", "d2": "banana bread", "d3": "cherry cake"}
    flat = BM25Index(docs)
    inverted = InvertedBM25Index(docs)
    assert flat.search("apple", 10) == inverted.search("apple", 10)
    assert len(inverted.search("apple", 10)) == 1


def test_postings_touched_is_the_sum_of_dfs():
    index = InvertedBM25Index(
        {
            "d1": "apple banana",
            "d2": "apple cherry",
            "d3": "apple durian",
        }
    )
    _, stats = index.search_with_stats("apple banana", top_k=10)
    assert stats.postings_touched == 4  # df(apple)=3 + df(banana)=1
    assert stats.candidates == 3
    assert stats.terms_matched == 2


def test_unknown_term_costs_nothing():
    index = InvertedBM25Index({"d1": "apple"})
    results, stats = index.search_with_stats("zebra", top_k=10)
    assert results == []
    assert stats.postings_touched == 0
    assert stats.candidates == 0
    assert stats.terms_matched == 0


def test_duplicate_query_terms_count_once():
    index = InvertedBM25Index({"d1": "cat sat", "d2": "cat cat"})
    once, stats_once = index.search_with_stats("cat", top_k=10)
    twice, stats_twice = index.search_with_stats("cat cat", top_k=10)
    assert once == twice
    assert stats_once == stats_twice


def test_empty_query_and_empty_corpus():
    index = InvertedBM25Index({"d1": "apple"})
    assert index.search("", top_k=10) == []
    empty = InvertedBM25Index({})
    assert empty.search("apple", top_k=10) == []


def test_doc_with_no_tokens_is_harmless():
    docs = {"d1": "apple pie", "d2": "!!! ...", "d3": "apple tart"}
    flat = BM25Index(docs)
    inverted = InvertedBM25Index(docs)
    assert flat.search("apple pie", 10) == inverted.search("apple pie", 10)


def test_score_ties_break_by_doc_id():
    # identical docs score identically; order must come from the id
    docs = {"z-doc": "apple", "a-doc": "apple", "m-doc": "apple"}
    results = InvertedBM25Index(docs).search("apple", top_k=3)
    assert [doc_id for doc_id, _ in results] == ["a-doc", "m-doc", "z-doc"]


def test_top_k_limits_results():
    docs = {f"d{i}": "apple" for i in range(10)}
    assert len(InvertedBM25Index(docs).search("apple", top_k=3)) == 3


def test_unicode_matches_flat_scan():
    docs = {
        "d1": "café au lait, s'il vous plaît",
        "d2": "naïve résumé señor",
        "d3": "日本語 テスト 文書",
    }
    flat = BM25Index(docs)
    inverted = InvertedBM25Index(docs)
    for query in ("CAFÉ", "résumé naïve", "日本語", "plaît señor"):
        assert flat.search(query, 10) == inverted.search(query, 10)


def test_oversized_query_matches_flat_scan():
    docs = generate_corpus(50, seed=9)
    flat = BM25Index(docs)
    inverted = InvertedBM25Index(docs)
    query = " ".join(docs.values())  # every term in the corpus at once
    assert flat.search(query, 10) == inverted.search(query, 10)


def test_postings_are_in_ascending_doc_order():
    index = InvertedBM25Index(generate_corpus(100, seed=3))
    for plist in index.postings.values():
        doc_indexes = [i for i, _ in plist]
        assert doc_indexes == sorted(doc_indexes)
        assert all(tf >= 1 for _, tf in plist)


def test_parameter_validation():
    with pytest.raises(ValueError, match="b must be"):
        InvertedBM25Index({"d1": "a"}, b=1.5)
    with pytest.raises(ValueError, match="k1 must be"):
        InvertedBM25Index({"d1": "a"}, k1=-1)
