"""End to end: dataset -> exact ground truth -> hnsw -> recall/cost, twice,
identically."""

from ann.dataset import clustered_dataset
from ann.exact import ExactIndex
from ann.hnsw import HnswIndex
from ann.reuse import ann_recall, mean


def run_pipeline() -> tuple[list[float], int, int]:
    data = clustered_dataset(250, 30, 8, 10, seed=101)
    exact = ExactIndex(dim=8)
    hnsw = HnswIndex(dim=8, m=8, ef_construction=50, seed=101)
    for v in data.vectors:
        exact.add(v)
        hnsw.add(v)
    build_dists = hnsw.distance_count
    truth = [exact.search(q, 10) for q in data.queries]
    hnsw.distance_count = 0
    recalls = []
    for ef in (10, 30, 60):
        recalls.append(
            mean([ann_recall(hnsw.search(q, 10, ef=ef), t, 10) for q, t in zip(data.queries, truth)])
        )
    return recalls, build_dists, hnsw.distance_count


def test_pipeline_recall_rises_to_near_exact() -> None:
    recalls, build_dists, search_dists = run_pipeline()
    assert recalls == sorted(recalls)
    assert recalls[-1] >= 0.95
    assert build_dists > 0
    # 3 sweeps x 30 queries against a 250-vector corpus, still cheaper than
    # one exhaustive pass per query
    assert search_dists < 3 * 30 * 250


def test_pipeline_is_deterministic() -> None:
    assert run_pipeline() == run_pipeline()
