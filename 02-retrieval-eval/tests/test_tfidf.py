import math

import pytest

from retrieval_eval.tfidf import TfidfIndex


def test_identical_query_and_doc_have_cosine_one():
    index = TfidfIndex({"d1": "cat sat", "d2": "dog ran"})
    results = index.search("cat sat", top_k=5)
    assert results[0][0] == "d1"
    assert results[0][1] == pytest.approx(1.0)


def test_hand_computed_cosine():
    index = TfidfIndex({"d1": "a b", "d2": "a c"})
    idf_a = math.log((1 + 2) / (1 + 2)) + 1
    idf_b = math.log((1 + 2) / (1 + 1)) + 1
    d1_norm = math.sqrt(idf_a**2 + idf_b**2)
    expected = idf_b / d1_norm  # query "b" normalizes to a unit vector on b
    results = dict(index.search("b", top_k=5))
    assert results == {"d1": pytest.approx(expected)}


def test_scores_are_bounded_and_sorted():
    index = TfidfIndex(
        {
            "d1": "cat sat mat",
            "d2": "cat dog fish",
            "d3": "bird song tree",
        }
    )
    results = index.search("cat sat mat", top_k=5)
    scores = [score for _, score in results]
    assert all(0 < score <= 1 + 1e-9 for score in scores)
    assert scores == sorted(scores, reverse=True)
    assert results[0][0] == "d1"


def test_unseen_query_terms_are_ignored():
    index = TfidfIndex({"d1": "cat sat", "d2": "dog ran"})
    with_noise = index.search("cat zzzz qqqq", top_k=5)
    assert with_noise[0][0] == "d1"


def test_empty_and_unknown_queries_return_nothing():
    index = TfidfIndex({"d1": "cat sat"})
    assert index.search("", top_k=5) == []
    assert index.search("zebra", top_k=5) == []


def test_empty_corpus_returns_nothing():
    index = TfidfIndex({})
    assert index.search("anything", top_k=5) == []


def test_duplicate_docs_tie_and_break_by_id():
    index = TfidfIndex({"b": "same text", "a": "same text"})
    results = index.search("same text", top_k=5)
    assert [doc_id for doc_id, _ in results] == ["a", "b"]
    assert results[0][1] == pytest.approx(results[1][1])


def test_raw_tf_does_not_saturate():
    # the property bm25 fixes: with equal-length docs, repeating a term
    # keeps increasing tf-idf cosine linearly in the vector weight
    index = TfidfIndex(
        {
            "once": "cat unrelated filler words",
            "many": "cat cat cat cat",
            "other": "dog dog dog dog",
        }
    )
    results = dict(index.search("cat", top_k=5))
    assert results["many"] > results["once"]


def test_top_k_limits_results():
    docs = {f"d{i}": "shared term" for i in range(20)}
    index = TfidfIndex(docs)
    assert len(index.search("shared", top_k=7)) == 7
