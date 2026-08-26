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
    assert reciprocal_rank(["a", "b"], {"a"}, k=10) == 1.0


def test_reciprocal_rank_third_position():
    assert reciprocal_rank(["x", "y", "a"], {"a"}, k=10) == pytest.approx(1 / 3)


def test_reciprocal_rank_not_found_is_zero():
    assert reciprocal_rank(["x", "y"], {"a"}, k=10) == 0.0


def test_reciprocal_rank_uses_first_relevant():
    assert reciprocal_rank(["x", "b", "a"], {"a", "b"}, k=10) == 0.5


def test_reciprocal_rank_k_cutoff_excludes_later_hits():
    # 02-retrieval-eval reports mrr@10 — a hit past the cutoff scores 0 there,
    # so it has to score 0 here too or the two projects mean different things
    # by the same metric name
    ranked = [f"x{i}" for i in range(10)] + ["a"]
    assert reciprocal_rank(ranked, {"a"}, k=10) == 0.0
    assert reciprocal_rank(ranked, {"a"}, k=11) == pytest.approx(1 / 11)


def test_reciprocal_rank_counts_the_hit_exactly_at_the_cutoff():
    ranked = [f"x{i}" for i in range(9)] + ["a"]
    assert reciprocal_rank(ranked, {"a"}, k=10) == pytest.approx(0.1)


def test_reciprocal_rank_invalid_k_raises():
    with pytest.raises(ValueError):
        reciprocal_rank(["a"], {"a"}, k=0)


def test_reciprocal_rank_empty_relevant_raises():
    with pytest.raises(ValueError):
        reciprocal_rank(["a"], set(), k=10)


def test_mean():
    assert mean([1.0, 0.0]) == 0.5


def test_mean_empty_raises():
    with pytest.raises(ValueError):
        mean([])
