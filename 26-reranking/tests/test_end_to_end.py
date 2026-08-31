"""Pins the published numbers on the committed data.

BM25- and oracle-derived figures are exact rationals and are pinned tight.
LSA-derived figures depend on the seeded SVD fit; they are deterministic
for a given environment and pinned tight too, with the structural findings
(identity of rankings, direction of gaps) asserted separately so a future
library version that shifts a third decimal fails loudly rather than
silently shipping stale prose.
"""

import pytest

from reranking.evaluate import Evaluator


def test_bm25_first_stage_published_numbers(evaluator):
    evaluation = evaluator.run_first_stage("bm25")
    assert evaluation.mrr == pytest.approx(0.8508333333333333, abs=1e-12)
    assert evaluation.mrr_by_category["keyword"] == pytest.approx(0.95, abs=1e-12)
    assert evaluation.mrr_by_category["paraphrase"] == pytest.approx(
        0.7516666666666667, abs=1e-12
    )
    assert evaluation.latent_dots_per_query == 0.0


def test_oracle_prices_the_shortlist_ceiling(evaluator):
    at_20 = evaluator.run_reranked("bm25", "oracle", 20)
    at_50 = evaluator.run_reranked("bm25", "oracle", 50)
    assert at_20.system.mrr == pytest.approx(0.95, abs=1e-12)
    assert at_20.gold_in_shortlist == pytest.approx(0.95, abs=1e-12)
    assert at_50.system.mrr == pytest.approx(1.0, abs=1e-12)
    assert at_50.gold_in_shortlist == pytest.approx(1.0, abs=1e-12)


def test_headline_identity_pooled_rerank_at_20_reproduces_the_full_dense_scan(
    evaluator,
):
    """The finding the README leads with: reranking bm25's top 20 with the
    pooled bi-encoder gives the same reciprocal rank as scanning all 100
    docs densely, on every single query, at a fifth of the latent dots."""
    pooled = evaluator.run_reranked("bm25", "pooled-lsa", 20)
    lsa = evaluator.run_first_stage("lsa")
    assert pooled.system.per_query_rr == lsa.per_query_rr
    assert pooled.system.latent_dots_per_query == pytest.approx(20.0, abs=1e-12)
    assert lsa.latent_dots_per_query == pytest.approx(100.0, abs=1e-12)
    assert pooled.demoted == 0


def test_lsa_first_stage_published_number(evaluator):
    evaluation = evaluator.run_first_stage("lsa")
    assert evaluation.mrr == pytest.approx(0.861, abs=5e-4)
    assert evaluation.mrr_by_category["keyword"] == pytest.approx(0.95, abs=1e-9)


def test_maxsim_reranking_hurts_on_this_corpus(evaluator):
    """Same space, finer interaction, worse ranking: the negative result."""
    bm25 = evaluator.run_first_stage("bm25")
    for depth in (10, 20, 100):
        maxsim = evaluator.run_reranked("bm25", "maxsim", depth)
        assert maxsim.system.mrr < bm25.mrr
        assert maxsim.demoted > maxsim.promoted
        # every doc it demotes is a paraphrase query: exact-match cosine 1.0
        # plus the stable sort keeps keyword rankings intact
        assert maxsim.system.mrr_by_category["keyword"] == pytest.approx(
            bm25.mrr_by_category["keyword"], abs=1e-12
        )


def test_depth_sweep_published_numbers(evaluator):
    assert evaluator.run_reranked("bm25", "pooled-lsa", 10).system.mrr == pytest.approx(
        0.858, abs=5e-4
    )
    assert evaluator.run_reranked("bm25", "maxsim", 20).system.mrr == pytest.approx(
        0.838, abs=5e-4
    )
    assert evaluator.run_reranked("bm25", "maxsim", 100).system.mrr == pytest.approx(
        0.825, abs=5e-4
    )


def test_maxsim_cost_accounting_published_number(evaluator):
    maxsim = evaluator.run_reranked("bm25", "maxsim", 20)
    assert maxsim.system.latent_dots_per_query == pytest.approx(1909.45, abs=1e-9)


def test_weak_scorer_on_strong_candidates_loses(evaluator):
    """Direction matters: bm25 rescoring lsa's shortlist gives back lsa's
    paraphrase wins and buys nothing."""
    lsa = evaluator.run_first_stage("lsa")
    reranked = evaluator.run_reranked("lsa", "bm25", 20)
    assert reranked.system.mrr < lsa.mrr
    assert reranked.promoted == 0


def test_the_query_no_reranker_can_fix(evaluator):
    """k14 'GIL' is out of vocabulary for every scorer and unmatched by
    bm25: reranking cannot manufacture a signal that is not there."""
    bm25 = evaluator.run_first_stage("bm25")
    assert bm25.per_query_rr["k14"] == 0.0
    for scorer in ("pooled-lsa", "maxsim"):
        assert evaluator.run_reranked("bm25", scorer, 20).system.per_query_rr[
            "k14"
        ] == 0.0
    # even the oracle needs the shortlist deep enough to contain the gold
    assert evaluator.run_reranked("bm25", "oracle", 20).system.per_query_rr["k14"] == 0.0
    assert evaluator.run_reranked("bm25", "oracle", 50).system.per_query_rr["k14"] == 1.0


def test_bootstrap_comparisons_published_directions(evaluator):
    bm25 = evaluator.run_first_stage("bm25")
    pooled = evaluator.run_reranked("bm25", "pooled-lsa", 20).system
    oracle = evaluator.run_reranked("bm25", "oracle", 20).system
    gap = evaluator.compare(pooled, bm25)
    assert gap.diff == pytest.approx(0.0106, abs=5e-4)
    assert gap.ci.lo >= 0.0  # never negative on a resample's 2.5th percentile
    headroom = evaluator.compare(oracle, pooled)
    assert headroom.diff > 0.05
    assert headroom.ci.lo > 0.0  # the one gap that clears zero


def test_everything_is_deterministic_across_fresh_builds(docs, queries, evaluator):
    rebuilt = Evaluator(docs, queries)
    for stage in ("bm25", "lsa", "rrf"):
        assert (
            rebuilt.run_first_stage(stage).per_query_rr
            == evaluator.run_first_stage(stage).per_query_rr
        )
    assert (
        rebuilt.run_reranked("bm25", "maxsim", 10).system.per_query_rr
        == evaluator.run_reranked("bm25", "maxsim", 10).system.per_query_rr
    )
