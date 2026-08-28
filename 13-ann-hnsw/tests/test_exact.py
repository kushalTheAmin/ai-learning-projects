import numpy as np
import pytest

from ann.exact import ExactIndex


def naive_topk(vectors: list[np.ndarray], query: np.ndarray, k: int) -> list[tuple[int, float]]:
    scored = [(float(np.sum((v - query) ** 2)), i) for i, v in enumerate(vectors)]
    scored.sort()
    return [(i, d) for d, i in scored[:k]]


def test_matches_naive_loop_on_random_data() -> None:
    rng = np.random.default_rng(7)
    vectors = [rng.normal(size=5) for _ in range(40)]
    index = ExactIndex(dim=5)
    for v in vectors:
        index.add(v)
    for _ in range(10):
        query = rng.normal(size=5)
        got = index.search(query, 6)
        want = naive_topk(vectors, query, 6)
        assert [i for i, _ in got] == [i for i, _ in want]
        assert [d for _, d in got] == pytest.approx([d for _, d in want])


def test_add_returns_sequential_ids() -> None:
    index = ExactIndex(dim=2)
    assert [index.add(np.zeros(2)) for _ in range(3)] == [0, 1, 2]


def test_distance_counter_counts_every_stored_vector() -> None:
    index = ExactIndex(dim=3)
    for _ in range(40):
        index.add(np.zeros(3))
    for _ in range(3):
        index.search(np.zeros(3), 5)
    assert index.distance_count == 120


def test_k_larger_than_index_returns_everything() -> None:
    index = ExactIndex(dim=2)
    index.add(np.array([0.0, 0.0]))
    index.add(np.array([1.0, 0.0]))
    assert len(index.search(np.zeros(2), 100)) == 2


def test_empty_index_returns_empty() -> None:
    assert ExactIndex(dim=4).search(np.zeros(4), 5) == []


def test_single_item() -> None:
    index = ExactIndex(dim=2)
    index.add(np.array([1.0, 1.0]))
    assert index.search(np.zeros(2), 1) == [(0, 2.0)]


def test_ties_broken_by_lower_id() -> None:
    index = ExactIndex(dim=2)
    for _ in range(4):
        index.add(np.array([3.0, 4.0]))
    assert [i for i, _ in index.search(np.zeros(2), 3)] == [0, 1, 2]


def test_rejects_bad_input() -> None:
    index = ExactIndex(dim=3)
    index.add(np.zeros(3))
    with pytest.raises(ValueError):
        index.search(np.zeros(3), 0)
    with pytest.raises(ValueError):
        index.search(np.zeros(2), 1)
    with pytest.raises(ValueError):
        index.add(np.array([1.0, np.nan, 0.0]))
    with pytest.raises(ValueError):
        index.search(np.array([np.inf, 0.0, 0.0]), 1)
    with pytest.raises(ValueError):
        ExactIndex(dim=0)
