import math

import pytest

from retrieval_eval.bm25 import BM25Index


def scores_for(index, query):
    return dict(index.search(query, top_k=100))


def test_hand_computed_score_single_doc():
    # one doc, so length_norm = 1; score = idf * tf*(k1+1)/(tf + k1)
    index = BM25Index({"d1": "cat sat on the mat"}, k1=1.5, b=0.75)
    expected_idf = math.log(1 + (1 - 1 + 0.5) / (1 + 0.5))
    expected = expected_idf * (1 * 2.5) / (1 + 1.5)
    results = index.search("cat", top_k=10)
    assert results == [("d1", pytest.approx(expected))]


def test_rare_term_outweighs_common_term():
    index = BM25Index(
        {
            "d1": "apple banana",
            "d2": "apple cherry",
            "d3": "apple durian",
        }
    )
    # "banana" is in one doc, "apple" in all three
    banana_score = scores_for(index, "banana")["d1"]
    apple_score = scores_for(index, "apple")["d1"]
    assert banana_score > apple_score


def test_term_frequency_saturates():
    # same-length docs with tf 1..4 of the query term: score rises,
    # but each extra occurrence is worth less than the previous one
    index = BM25Index(
        {
            "d1": "cat a b c",
            "d2": "cat cat b c",
            "d3": "cat cat cat c",
            "d4": "cat cat cat cat",
        }
    )
    s = scores_for(index, "cat")
    assert s["d1"] < s["d2"] < s["d3"] < s["d4"]
    gains = [s["d2"] - s["d1"], s["d3"] - s["d2"], s["d4"] - s["d3"]]
    assert gains[0] > gains[1] > gains[2]


def test_length_normalization_penalizes_long_docs():
    docs = {"short": "cat mat", "long": "cat mat mat mat mat mat"}
    with_norm = scores_for(BM25Index(docs, b=0.75), "cat")
    assert with_norm["short"] > with_norm["long"]
    without_norm = scores_for(BM25Index(docs, b=0.0), "cat")
    assert without_norm["short"] == pytest.approx(without_norm["long"])


def test_empty_corpus_returns_nothing():
    index = BM25Index({})
    assert index.search("anything", top_k=5) == []


def test_single_doc_corpus():
    index = BM25Index({"only": "the only document here"})
    assert [doc_id for doc_id, _ in index.search("document", top_k=5)] == ["only"]


def test_empty_and_unknown_queries_return_nothing():
    index = BM25Index({"d1": "cat sat"})
    assert index.search("", top_k=5) == []
    assert index.search("!!! ...", top_k=5) == []
    assert index.search("zebra quantum", top_k=5) == []


def test_duplicate_query_terms_do_not_double_count():
    index = BM25Index({"d1": "cat sat", "d2": "dog ran"})
    assert scores_for(index, "cat cat cat") == scores_for(index, "cat")


def test_top_k_limits_results():
    docs = {f"d{i}": "shared term here" for i in range(20)}
    index = BM25Index(docs)
    assert len(index.search("shared", top_k=5)) == 5


def test_ties_break_by_doc_id_ascending():
    index = BM25Index({"b": "same text", "a": "same text"})
    assert [doc_id for doc_id, _ in index.search("same", top_k=5)] == ["a", "b"]


def test_oversized_query_is_handled():
    index = BM25Index({"d1": "needle in a haystack"})
    huge_query = "needle " * 10_000
    assert [doc_id for doc_id, _ in index.search(huge_query, top_k=5)] == ["d1"]


def test_unicode_query_matches_unicode_doc():
    index = BM25Index({"fr": "café et croissant", "en": "coffee and croissant"})
    assert index.search("Café", top_k=5)[0][0] == "fr"


def test_invalid_parameters_rejected():
    with pytest.raises(ValueError):
        BM25Index({"d1": "x"}, b=1.5)
    with pytest.raises(ValueError):
        BM25Index({"d1": "x"}, k1=-1)
