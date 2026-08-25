import numpy as np
import pytest

from hybrid_search.bm25 import BM25

CORPUS = [
    "the cat sat on the mat",
    "dogs chase cats around the yard",
    "quantum entanglement in photon pairs",
    "the dog barked at the mailman",
]


def test_empty_corpus_raises():
    with pytest.raises(ValueError):
        BM25().fit([])


def test_scores_before_fit_raises():
    with pytest.raises(RuntimeError):
        BM25().scores("anything")


def test_rare_term_ranks_its_document_first():
    bm25 = BM25().fit(CORPUS)
    assert bm25.rank("quantum entanglement")[0] == 2


def test_oov_query_scores_zero_everywhere():
    bm25 = BM25().fit(CORPUS)
    assert np.all(bm25.scores("zebra xylophone") == 0.0)


def test_empty_query_scores_zero_everywhere():
    bm25 = BM25().fit(CORPUS)
    assert np.all(bm25.scores("") == 0.0)


def test_term_frequency_saturates():
    corpus = ["cat", "cat cat cat cat cat cat cat cat filler filler"]
    bm25 = BM25().fit(corpus)
    one = bm25.scores("cat")
    # 8x the term frequency must yield far less than 8x the score
    assert one[1] < 4 * one[0]


def test_shorter_doc_wins_at_equal_term_frequency():
    corpus = [
        "error handling",
        "error handling plus many extra words diluting the topic entirely",
    ]
    scores = BM25().fit(corpus).scores("error")
    assert scores[0] > scores[1]


def test_matching_more_query_terms_scores_higher():
    bm25 = BM25().fit(CORPUS)
    scores = bm25.scores("dogs chase cats")
    assert scores[1] > scores[3]


def test_single_document_corpus():
    bm25 = BM25().fit(["just one document"])
    assert bm25.scores("document")[0] > 0.0


def test_duplicate_documents_score_identically():
    bm25 = BM25().fit(["same text here", "same text here"])
    scores = bm25.scores("same text")
    assert scores[0] == pytest.approx(scores[1])


def test_deterministic_across_fits():
    a = BM25().fit(CORPUS).scores("cat dog quantum")
    b = BM25().fit(CORPUS).scores("cat dog quantum")
    assert np.array_equal(a, b)


def test_oversized_query_does_not_crash():
    bm25 = BM25().fit(CORPUS)
    huge = "cat dog quantum " * 5000
    assert bm25.rank(huge).shape == (len(CORPUS),)
