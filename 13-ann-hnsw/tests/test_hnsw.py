import numpy as np
import pytest

from ann.dataset import clustered_dataset
from ann.exact import ExactIndex
from ann.hnsw import HnswIndex
from ann.reuse import ann_recall, mean


def build_pair(n: int, dim: int, seed: int, m: int = 8, ef_c: int = 60) -> tuple[HnswIndex, ExactIndex, np.ndarray]:
    rng = np.random.default_rng(seed)
    vectors = rng.normal(size=(n, dim))
    hnsw = HnswIndex(dim=dim, m=m, ef_construction=ef_c, seed=seed)
    exact = ExactIndex(dim=dim)
    for v in vectors:
        hnsw.add(v)
        exact.add(v)
    return hnsw, exact, vectors


def test_wide_beam_matches_exact_on_small_index() -> None:
    hnsw, exact, _ = build_pair(n=60, dim=6, seed=3)
    rng = np.random.default_rng(4)
    for _ in range(20):
        query = rng.normal(size=6)
        got = hnsw.search(query, 5, ef=60)
        want = exact.search(query, 5)
        assert [i for i, _ in got] == [i for i, _ in want]
        assert [d for _, d in got] == pytest.approx([d for _, d in want])


def test_indexed_vector_is_its_own_nearest_neighbor() -> None:
    hnsw, _, vectors = build_pair(n=80, dim=4, seed=5)
    for node in (0, 17, 79):
        results = hnsw.search(vectors[node], 1, ef=40)
        assert results[0] == (node, 0.0)


def test_duplicates_are_all_retrievable() -> None:
    rng = np.random.default_rng(9)
    hnsw = HnswIndex(dim=3, m=4, ef_construction=30, seed=9)
    dupe = np.array([0.5, 0.5, 0.5])
    dupe_ids = []
    for i in range(30):
        if i % 6 == 0:
            dupe_ids.append(hnsw.add(dupe))
        else:
            hnsw.add(rng.normal(size=3) + 5.0)
    results = hnsw.search(dupe, len(dupe_ids), ef=30)
    assert sorted(i for i, _ in results) == dupe_ids
    assert all(d == 0.0 for _, d in results)


def test_empty_single_and_oversized_k() -> None:
    hnsw = HnswIndex(dim=2, m=4, ef_construction=10, seed=0)
    assert hnsw.search(np.zeros(2), 5, ef=10) == []
    hnsw.add(np.array([1.0, 0.0]))
    assert hnsw.search(np.zeros(2), 1, ef=10) == [(0, 1.0)]
    hnsw.add(np.array([0.0, 2.0]))
    assert len(hnsw.search(np.zeros(2), 100, ef=10)) == 2


def test_ef_below_k_is_raised_to_k() -> None:
    hnsw, exact, _ = build_pair(n=50, dim=4, seed=11)
    query = np.zeros(4)
    assert len(hnsw.search(query, 10, ef=1)) == 10


def test_rejects_bad_input() -> None:
    hnsw = HnswIndex(dim=3, m=4, ef_construction=10, seed=0)
    hnsw.add(np.zeros(3))
    with pytest.raises(ValueError):
        hnsw.search(np.zeros(3), 0, ef=10)
    with pytest.raises(ValueError):
        hnsw.search(np.zeros(3), 1, ef=0)
    with pytest.raises(ValueError):
        hnsw.search(np.zeros(2), 1, ef=10)
    with pytest.raises(ValueError):
        hnsw.add(np.array([np.nan, 0.0, 0.0]))
    with pytest.raises(ValueError):
        HnswIndex(dim=3, m=1)
    with pytest.raises(ValueError):
        HnswIndex(dim=3, m=4, ef_construction=0)


def test_degree_caps_hold_on_every_layer() -> None:
    hnsw, _, _ = build_pair(n=400, dim=8, seed=13, m=6, ef_c=40)
    assert max(hnsw.degrees(0)) <= hnsw.m0
    for layer in range(1, hnsw._max_level + 1):
        degrees = hnsw.degrees(layer)
        if degrees:
            assert max(degrees) <= hnsw.m


def test_level_counts_sum_to_size_and_bottom_dominates() -> None:
    hnsw, _, _ = build_pair(n=400, dim=8, seed=13, m=6, ef_c=40)
    counts = hnsw.level_counts()
    assert sum(counts) == 400
    assert counts[0] > sum(counts[1:])


def test_layer0_fully_connected_with_heuristic() -> None:
    data = clustered_dataset(300, 10, 8, 20, seed=21, cluster_std=0.05)
    hnsw = HnswIndex(dim=8, m=6, ef_construction=60, seed=21)
    for v in data.vectors:
        hnsw.add(v)
    assert hnsw.reachable_on_layer0() == 300


def test_same_seed_same_graph_same_results() -> None:
    a, _, vectors = build_pair(n=200, dim=6, seed=17)
    b, _, _ = build_pair(n=200, dim=6, seed=17)
    for node in range(200):
        for layer in range(len(a._links[node])):
            assert a.neighbors(node, layer) == b.neighbors(node, layer)
    query = vectors[0] + 0.1
    assert a.search(query, 10, ef=30) == b.search(query, 10, ef=30)


def test_recall_does_not_drop_as_ef_grows() -> None:
    data = clustered_dataset(400, 40, 16, 12, seed=29)
    exact = ExactIndex(dim=16)
    hnsw = HnswIndex(dim=16, m=8, ef_construction=80, seed=29)
    for v in data.vectors:
        exact.add(v)
        hnsw.add(v)
    truth = [exact.search(q, 10) for q in data.queries]

    def recall_at(ef: int) -> float:
        return mean(
            [ann_recall(hnsw.search(q, 10, ef=ef), t, 10) for q, t in zip(data.queries, truth)]
        )

    low, high = recall_at(10), recall_at(80)
    assert high >= low
    assert high >= 0.95


def test_hnsw_spends_fewer_distances_than_exact() -> None:
    data = clustered_dataset(400, 40, 16, 12, seed=29)
    exact = ExactIndex(dim=16)
    hnsw = HnswIndex(dim=16, m=8, ef_construction=80, seed=29)
    for v in data.vectors:
        exact.add(v)
        hnsw.add(v)
    exact.distance_count = 0
    hnsw.distance_count = 0
    for q in data.queries:
        exact.search(q, 10)
        hnsw.search(q, 10, ef=20)
    assert exact.distance_count == 400 * 40
    assert hnsw.distance_count < exact.distance_count / 2
