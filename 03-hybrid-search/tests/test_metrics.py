import pytest

from hybrid_search.metrics import mean, recall_at_k, reciprocal_rank


def test_recall_full_hit():
    assert recall_at_k(["a", "b", "c"], {"a", "b"}, k=2) == 1.0


def test_recall_partial_hit():
    assert recall_at_k(["a", "x", "y"], {"a", "b"}, k=3) == 0.5


def test_recall_miss():
    assert recall_at_k(["x", "y"], {"a"}, k=2) == 0.0


def test_recall_k_larger_than_list():
    assert recall_at_k(["a"], {"a", "b"}, k=100) == 0.5


def test_recall_k_cutoff_excludes_later_hits():
    assert recall_at_k(["x", "a"], {"a"}, k=1) == 0.0


def test_recall_invalid_k_raises():
    with pytest.raises(ValueError):
        recall_at_k(["a"], {"a"}, k=0)


def test_recall_empty_relevant_raises():
    with pytest.raises(ValueError):
        recall_at_k(["a"], set(), k=1)


def test_reciprocal_rank_first_position():
    assert reciprocal_rank(["a", "b"], {"a"}) == 1.0


def test_reciprocal_rank_third_position():
    assert reciprocal_rank(["x", "y", "a"], {"a"}) == pytest.approx(1 / 3)


def test_reciprocal_rank_not_found_is_zero():
    assert reciprocal_rank(["x", "y"], {"a"}) == 0.0


def test_reciprocal_rank_uses_first_relevant():
    assert reciprocal_rank(["x", "b", "a"], {"a", "b"}) == 0.5


def test_reciprocal_rank_empty_relevant_raises():
    with pytest.raises(ValueError):
        reciprocal_rank(["a"], set())


def test_mean():
    assert mean([1.0, 0.0]) == 0.5


def test_mean_empty_raises():
    with pytest.raises(ValueError):
        mean([])
