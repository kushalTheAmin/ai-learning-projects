import numpy as np
import pytest

from hybrid_search.fusion import reciprocal_rank_fusion, weighted_score_fusion


def test_rrf_empty_input_raises():
    with pytest.raises(ValueError):
        reciprocal_rank_fusion([])


def test_rrf_mismatched_lengths_raise():
    with pytest.raises(ValueError):
        reciprocal_rank_fusion([np.array([0, 1, 2]), np.array([0, 1])])


def test_rrf_agreement_preserves_order():
    ranking = np.array([2, 0, 1])
    fused = reciprocal_rank_fusion([ranking, ranking.copy()])
    assert list(fused) == [2, 0, 1]


def test_rrf_rewards_consistent_top_placement():
    # doc 0: ranks 1 and 2; doc 1: ranks 2 and 1; doc 2: ranks 3 and 3
    a = np.array([0, 1, 2])
    b = np.array([1, 0, 2])
    fused = reciprocal_rank_fusion([a, b])
    assert fused[2] == 2  # the consistently-last doc stays last


def test_rrf_single_ranking_is_identity():
    ranking = np.array([3, 1, 0, 2])
    assert list(reciprocal_rank_fusion([ranking])) == [3, 1, 0, 2]


def test_weighted_alpha_out_of_bounds_raises():
    scores = np.array([1.0, 2.0])
    with pytest.raises(ValueError):
        weighted_score_fusion(scores, scores, alpha=1.5)
    with pytest.raises(ValueError):
        weighted_score_fusion(scores, scores, alpha=-0.1)


def test_weighted_shape_mismatch_raises():
    with pytest.raises(ValueError):
        weighted_score_fusion(np.array([1.0]), np.array([1.0, 2.0]), alpha=0.5)


def test_weighted_alpha_zero_is_pure_bm25():
    bm25 = np.array([0.1, 0.9, 0.5])
    dense = np.array([0.9, 0.1, 0.5])
    fused = weighted_score_fusion(bm25, dense, alpha=0.0)
    assert list(fused) == [1, 2, 0]


def test_weighted_alpha_one_is_pure_dense():
    bm25 = np.array([0.1, 0.9, 0.5])
    dense = np.array([0.9, 0.1, 0.5])
    fused = weighted_score_fusion(bm25, dense, alpha=1.0)
    assert list(fused) == [0, 2, 1]


def test_weighted_constant_scores_do_not_crash():
    constant = np.array([0.5, 0.5, 0.5])
    varying = np.array([0.9, 0.1, 0.5])
    fused = weighted_score_fusion(constant, varying, alpha=0.5)
    assert list(fused) == [0, 2, 1]


def test_weighted_normalization_makes_scales_comparable():
    # bm25-style scores in [0, 20], dense-style in [0, 1]; without min-max
    # normalization the bm25 side would drown out dense at alpha 0.5
    bm25 = np.array([20.0, 19.0, 0.0])
    dense = np.array([0.0, 1.0, 0.2])
    fused = weighted_score_fusion(bm25, dense, alpha=0.5)
    assert fused[0] == 1  # strong on both normalized sides wins
