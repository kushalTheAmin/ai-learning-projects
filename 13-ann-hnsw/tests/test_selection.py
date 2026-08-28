"""White-box tests for the neighbor selection rule, on hand-placed geometry."""

import numpy as np

from ann.dataset import clustered_dataset
from ann.exact import ExactIndex
from ann.hnsw import HnswIndex
from ann.reuse import ann_recall, mean


def selection_fixture(heuristic: bool) -> tuple[HnswIndex, list[tuple[float, int]], np.ndarray]:
    """Three stored points seen from the origin: two nearly coincident to the
    east (ids 0, 1), one alone to the west (id 2)."""
    index = HnswIndex(dim=2, m=2, heuristic=heuristic)
    for point in ([1.0, 0.0], [1.2, 0.0], [-1.5, 0.0]):
        index._append(np.array(point, dtype=np.float64))
    origin = np.zeros(2)
    candidates = sorted(
        (float(np.sum((index._store[i] - origin) ** 2)), i) for i in range(3)
    )
    return index, candidates, origin


def test_naive_selection_crowds_into_one_direction() -> None:
    index, candidates, origin = selection_fixture(heuristic=False)
    assert index._select_neighbors(origin, candidates, 2) == [0, 1]


def test_heuristic_selection_keeps_the_lone_direction() -> None:
    index, candidates, origin = selection_fixture(heuristic=True)
    assert index._select_neighbors(origin, candidates, 2) == [0, 2]


def test_heuristic_fills_spare_slots_from_discarded() -> None:
    index, candidates, origin = selection_fixture(heuristic=True)
    assert index._select_neighbors(origin, candidates, 3) == [0, 2, 1]


def test_heuristic_beats_naive_on_tight_clusters() -> None:
    data = clustered_dataset(300, 40, 16, 24, seed=31, cluster_std=0.05)
    exact = ExactIndex(dim=16)
    for v in data.vectors:
        exact.add(v)
    truth = [exact.search(q, 10) for q in data.queries]
    recalls = {}
    for heuristic in (True, False):
        hnsw = HnswIndex(dim=16, m=4, ef_construction=40, seed=31, heuristic=heuristic)
        for v in data.vectors:
            hnsw.add(v)
        recalls[heuristic] = mean(
            [ann_recall(hnsw.search(q, 10, ef=20), t, 10) for q, t in zip(data.queries, truth)]
        )
    assert recalls[True] > recalls[False]
