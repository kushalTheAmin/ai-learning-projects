import pytest

from reranking.reuse import recall_at_k


def test_unknown_stage_rejected(evaluator):
    with pytest.raises(ValueError, match="unknown first stage"):
        evaluator.run_reranked("rrf", "oracle", 10)


def test_unknown_scorer_rejected(evaluator):
    with pytest.raises(ValueError, match="unknown scorer"):
        evaluator.run_reranked("bm25", "cross-encoder", 10)


def test_nonpositive_depth_rejected(evaluator):
    with pytest.raises(ValueError, match="depth"):
        evaluator.run_reranked("bm25", "oracle", 0)


def test_reranking_lsa_with_its_own_pooled_scorer_is_the_identity(evaluator, docs):
    """The pooled scorer IS the lsa first stage, so reranking its own full
    ranking must change nothing. This pins shortlist assembly, tie handling
    and rr bookkeeping all at once."""
    first = evaluator.run_first_stage("lsa")
    result = evaluator.run_reranked("lsa", "pooled-lsa", len(docs))
    assert result.system.per_query_rr == first.per_query_rr
    assert result.promoted == 0
    assert result.demoted == 0


def test_depth_beyond_corpus_size_equals_full_depth(evaluator, docs):
    at_corpus = evaluator.run_reranked("bm25", "maxsim", len(docs))
    beyond = evaluator.run_reranked("bm25", "maxsim", len(docs) + 400)
    assert beyond.system.per_query_rr == at_corpus.system.per_query_rr


def test_depth_one_changes_nothing(evaluator):
    first = evaluator.run_first_stage("bm25")
    result = evaluator.run_reranked("bm25", "maxsim", 1)
    assert result.system.per_query_rr == first.per_query_rr


def test_gold_in_shortlist_is_first_stage_recall_at_depth(evaluator, queries):
    depth = 10
    result = evaluator.run_reranked("bm25", "oracle", depth)
    expected = sum(
        recall_at_k(
            evaluator._stage_rankings["bm25"][q.query_id], list(q.relevant), depth
        )
        for q in queries
    ) / len(queries)
    assert result.gold_in_shortlist == pytest.approx(expected, abs=1e-12)


def test_gold_below_the_cutoff_keeps_its_first_stage_rank(evaluator, queries):
    """The ceiling in action: even the oracle cannot move a gold doc the
    first stage left outside the shortlist."""
    depth = 20
    first = evaluator.run_first_stage("bm25")
    oracle = evaluator.run_reranked("bm25", "oracle", depth)
    outside = [
        q
        for q in queries
        if recall_at_k(
            evaluator._stage_rankings["bm25"][q.query_id], list(q.relevant), depth
        )
        == 0.0
    ]
    assert outside, "expected at least one query with gold below the cutoff"
    for q in outside:
        assert oracle.system.per_query_rr[q.query_id] == first.per_query_rr[q.query_id]


def test_oracle_never_demotes(evaluator):
    for depth in (5, 20, 100):
        assert evaluator.run_reranked("bm25", "oracle", depth).demoted == 0


def test_promoted_and_demoted_counts_match_per_query_deltas(evaluator, queries):
    first = evaluator.run_first_stage("bm25")
    result = evaluator.run_reranked("bm25", "maxsim", 10)
    promoted = sum(
        1
        for q in queries
        if result.system.per_query_rr[q.query_id] > first.per_query_rr[q.query_id]
    )
    demoted = sum(
        1
        for q in queries
        if result.system.per_query_rr[q.query_id] < first.per_query_rr[q.query_id]
    )
    assert (result.promoted, result.demoted) == (promoted, demoted)
    assert promoted + demoted <= len(queries)


def test_category_means_reconstruct_overall_mrr(evaluator, queries):
    evaluation = evaluator.run_first_stage("bm25")
    n_keyword = sum(1 for q in queries if q.category == "keyword")
    n_paraphrase = len(queries) - n_keyword
    reconstructed = (
        evaluation.mrr_by_category["keyword"] * n_keyword
        + evaluation.mrr_by_category["paraphrase"] * n_paraphrase
    ) / len(queries)
    assert evaluation.mrr == pytest.approx(reconstructed, abs=1e-12)


def test_compare_of_a_system_with_itself_is_exactly_zero(evaluator):
    evaluation = evaluator.run_first_stage("bm25")
    comparison = evaluator.compare(evaluation, evaluation)
    assert comparison.diff == 0.0
    assert comparison.ci.lo == 0.0
    assert comparison.ci.hi == 0.0


def test_cost_accounting_stage_plus_scorer(evaluator, docs):
    # bm25 stage pays no latent dots, so the pipeline cost is the scorer's
    pooled = evaluator.run_reranked("bm25", "pooled-lsa", 20)
    assert pooled.system.latent_dots_per_query == pytest.approx(20.0, abs=1e-12)
    # an lsa stage pays the full pooled scan before the scorer starts
    lsa_oracle = evaluator.run_reranked("lsa", "oracle", 20)
    assert lsa_oracle.system.latent_dots_per_query == pytest.approx(
        float(len(docs)), abs=1e-12
    )
