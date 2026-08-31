import numpy as np
import pytest

from reranking.data import Query
from reranking.rerank import (
    Bm25Scorer,
    MaxSimScorer,
    OracleScorer,
    PooledLsaScorer,
    rerank,
)
from reranking.reuse import DenseLSA


def make_query(text, relevant=("git-01",)):
    return Query(query_id="test", text=text, relevant=tuple(relevant), category="keyword")


@pytest.fixture(scope="module")
def maxsim(evaluator):
    return MaxSimScorer(evaluator.space)


@pytest.fixture(scope="module")
def pooled(evaluator):
    return PooledLsaScorer(evaluator.lsa, evaluator.doc_ids)


@pytest.fixture(scope="module")
def bm25_scorer(evaluator):
    return Bm25Scorer(evaluator.bm25, evaluator.doc_ids)


def test_maxsim_scores_a_doc_against_its_own_text_at_one(evaluator, maxsim, docs):
    doc = docs[0]
    scores, _ = maxsim.score(make_query(doc.text), [doc.doc_id])
    assert scores[doc.doc_id] == pytest.approx(1.0, abs=1e-9)


def test_maxsim_full_term_match_scores_exactly_one(evaluator, maxsim, docs):
    # a query made of terms the doc contains hits cosine 1.0 on every term
    doc = docs[0]
    words = [w for w in doc.text.split() if w.isalpha()][:3]
    scores, _ = maxsim.score(make_query(" ".join(words)), [doc.doc_id])
    assert scores[doc.doc_id] == pytest.approx(1.0, abs=1e-9)


def test_maxsim_out_of_vocabulary_query_scores_zero_at_zero_cost(maxsim, docs):
    candidates = [d.doc_id for d in docs[:5]]
    scores, dots = maxsim.score(make_query("GIL"), candidates)
    assert dots == 0
    assert all(score == 0.0 for score in scores.values())


def test_maxsim_dot_accounting_is_query_terms_times_doc_terms(evaluator, maxsim, docs):
    space = evaluator.space
    query = make_query("delete remote branch")
    candidates = [d.doc_id for d in docs[:7]]
    _, dots = maxsim.score(query, candidates)
    n_query_terms = len(space.term_indices(query.text))
    expected = sum(
        n_query_terms * len(space.profiles[doc_id].term_indices)
        for doc_id in candidates
        if len(space.profiles[doc_id].term_indices) > 0
    )
    assert n_query_terms > 0
    assert dots == expected


def test_maxsim_scores_are_bounded_by_cosine(maxsim, docs):
    scores, _ = maxsim.score(
        make_query("delete remote branch commit"), [d.doc_id for d in docs]
    )
    assert all(-1.0 - 1e-9 <= s <= 1.0 + 1e-9 for s in scores.values())


def test_pooled_scorer_matches_dense_lsa_scores(evaluator, pooled, queries):
    """The candidate-subset path must agree with 03's full scan to float
    noise (a subset matmul may sum in a different order than the full one,
    so bit-identity is not something numpy promises)."""
    for query in queries[:8]:
        candidates = evaluator.doc_ids[10:30]
        scores, dots = pooled.score(query, candidates)
        full = evaluator.lsa.scores(query.text)
        assert dots == len(candidates)
        for doc_id in candidates:
            assert scores[doc_id] == pytest.approx(
                full[evaluator.doc_ids.index(doc_id)], abs=1e-12
            )


def test_pooled_scorer_requires_fitted_lsa():
    with pytest.raises(ValueError, match="fitted"):
        PooledLsaScorer(DenseLSA(), ["d1"])


def test_pooled_scorer_handles_empty_candidates(pooled):
    scores, dots = pooled.score(make_query("delete branch"), [])
    assert scores == {}
    assert dots == 0


def test_bm25_scorer_matches_full_scan_at_zero_latent_cost(
    evaluator, bm25_scorer, queries
):
    query = queries[0]
    candidates = evaluator.doc_ids[:15]
    scores, dots = bm25_scorer.score(query, candidates)
    full = evaluator.bm25.scores(query.text)
    assert dots == 0
    for i, doc_id in enumerate(candidates):
        assert scores[doc_id] == full[i]


def test_oracle_scores_gold_one_and_rest_zero(docs):
    gold = docs[3].doc_id
    candidates = [d.doc_id for d in docs[:5]]
    scores, dots = OracleScorer().score(make_query("anything", [gold]), candidates)
    assert dots == 0
    assert scores[gold] == 1.0
    assert sum(scores.values()) == 1.0


def test_rerank_puts_oracle_gold_first_and_keeps_stage_order_elsewhere(docs):
    candidates = [d.doc_id for d in docs[:6]]
    gold = candidates[4]
    result = rerank(OracleScorer(), make_query("anything", [gold]), candidates)
    assert result.ranked_ids[0] == gold
    assert result.ranked_ids[1:] == [c for c in candidates if c != gold]


def test_rerank_preserves_order_on_all_tied_scores(maxsim, docs):
    # an out-of-vocabulary query gives the scorer nothing: order must hold
    candidates = [d.doc_id for d in docs[:8]]
    result = rerank(maxsim, make_query("GIL"), candidates)
    assert result.ranked_ids == candidates


def test_rerank_on_empty_query_text_preserves_order(maxsim, docs):
    candidates = [d.doc_id for d in docs[:4]]
    result = rerank(maxsim, make_query(""), candidates)
    assert result.ranked_ids == candidates


def test_rerank_rejects_duplicate_candidates(maxsim, docs):
    doc_id = docs[0].doc_id
    with pytest.raises(ValueError, match="unique"):
        rerank(maxsim, make_query("delete"), [doc_id, doc_id])


def test_rerank_survives_oversized_and_unicode_queries(evaluator, maxsim, docs):
    candidates = [d.doc_id for d in docs[:5]]
    huge = " ".join(list(evaluator.space.vocab)[:500] * 4)
    result = rerank(maxsim, make_query(huge), candidates)
    assert sorted(result.ranked_ids) == sorted(candidates)
    noisy = rerank(maxsim, make_query("café 削除 \U0001f680 delete"), candidates)
    assert sorted(noisy.ranked_ids) == sorted(candidates)


def test_rerank_sorts_best_first(pooled, evaluator, queries):
    query = queries[0]
    candidates = evaluator.doc_ids[:20]
    result = rerank(pooled, query, candidates)
    ordered = [result.scores[doc_id] for doc_id in result.ranked_ids]
    assert ordered == sorted(ordered, reverse=True)
    assert np.isfinite(ordered).all()
