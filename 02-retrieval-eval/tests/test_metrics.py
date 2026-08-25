import pytest

from retrieval_eval.metrics import mean, recall_at_k, reciprocal_rank


def test_recall_at_k_hand_computed():
    ranked = ["a", "b", "c", "d"]
    assert recall_at_k(ranked, ["a"], 1) == 1.0
    assert recall_at_k(ranked, ["b"], 1) == 0.0
    assert recall_at_k(ranked, ["b", "d"], 2) == 0.5
    assert recall_at_k(ranked, ["b", "d"], 4) == 1.0
    assert recall_at_k(ranked, ["z"], 4) == 0.0


def test_recall_with_empty_ranking():
    assert recall_at_k([], ["a"], 5) == 0.0


def test_recall_ignores_duplicate_relevant_ids():
    assert recall_at_k(["a", "b"], ["a", "a"], 2) == 1.0


def test_recall_rejects_bad_arguments():
    with pytest.raises(ValueError):
        recall_at_k(["a"], [], 1)
    with pytest.raises(ValueError):
        recall_at_k(["a"], ["a"], 0)


def test_reciprocal_rank_hand_computed():
    ranked = ["x", "y", "z"]
    assert reciprocal_rank(ranked, ["x"], 10) == 1.0
    assert reciprocal_rank(ranked, ["y"], 10) == 0.5
    assert reciprocal_rank(ranked, ["z"], 10) == pytest.approx(1 / 3)
    assert reciprocal_rank(ranked, ["missing"], 10) == 0.0


def test_reciprocal_rank_respects_cutoff():
    ranked = ["a", "b", "c"]
    assert reciprocal_rank(ranked, ["c"], 2) == 0.0
    assert reciprocal_rank(ranked, ["c"], 3) == pytest.approx(1 / 3)


def test_reciprocal_rank_uses_first_relevant_hit():
    assert reciprocal_rank(["a", "b"], ["b", "a"], 10) == 1.0


def test_reciprocal_rank_rejects_bad_arguments():
    with pytest.raises(ValueError):
        reciprocal_rank(["a"], [], 1)
    with pytest.raises(ValueError):
        reciprocal_rank(["a"], ["a"], 0)


def test_mean():
    assert mean([1.0, 2.0, 3.0]) == 2.0
    with pytest.raises(ValueError):
        mean([])
