"""End to end: build, grow, delete, persist, reload, compact, and hold the
recall story together on one seeded dataset."""

import numpy as np

from vecstore import (
    MutableHnswIndex,
    ann_recall,
    clustered_dataset,
    load_store,
    mean,
    save_store,
)

SEED = 21
DIM = 12
K = 5
EF = 40


def build(vectors: np.ndarray) -> MutableHnswIndex:
    index = MutableHnswIndex(dim=DIM, m=8, ef_construction=50, seed=SEED)
    for row in vectors:
        index.add(row)
    return index


def mean_recall(index: MutableHnswIndex, queries: np.ndarray) -> float:
    return mean(
        [
            ann_recall(index.search_live(q, K, EF), index.exact_live_topk(q, K), K)
            for q in queries
        ]
    )


def test_full_lifecycle(tmp_path):
    data = clustered_dataset(
        n_vectors=400, n_queries=30, dim=DIM, n_clusters=5, seed=SEED
    )
    index = build(data.vectors[:300])

    assert mean_recall(index, data.queries) > 0.9

    for row in data.vectors[300:]:
        index.add(row)
    assert len(index) == 400
    grown_recall = mean_recall(index, data.queries)
    assert grown_recall > 0.9

    doomed = np.random.default_rng(SEED).permutation(400)[:100]
    for node in doomed:
        index.delete(int(node))
    assert index.live_count == 300
    deleted_recall = mean_recall(index, data.queries)
    assert deleted_recall > 0.85
    for q in data.queries:
        live = set(index.live_ids())
        assert all(node in live for node, _ in index.search_live(q, K, EF))

    path = tmp_path / "store.bin"
    save_store(index, path)
    loaded = load_store(path)
    assert loaded.live_count == 300
    for q in data.queries:
        assert loaded.search_live(q, K, EF) == index.search_live(q, K, EF)

    compacted, id_map = loaded.compact(seed=SEED)
    assert len(compacted) == 300
    assert mean_recall(compacted, data.queries) > 0.85
    reverse = {new: old for old, new in id_map.items()}
    for q in data.queries:
        old_exact = [node for node, _ in loaded.exact_live_topk(q, K)]
        new_exact = [reverse[node] for node, _ in compacted.exact_live_topk(q, K)]
        assert old_exact == new_exact


def test_incremental_equals_fresh_build_in_same_order(tmp_path):
    data = clustered_dataset(
        n_vectors=250, n_queries=15, dim=DIM, n_clusters=4, seed=SEED
    )
    grown = build(data.vectors[:150])
    path = tmp_path / "store.bin"
    save_store(grown, path)
    grown = load_store(path)
    for row in data.vectors[150:]:
        grown.add(row)

    fresh = build(data.vectors)
    assert grown._links == fresh._links
    assert grown._entry == fresh._entry
    for q in data.queries:
        assert grown.search_live(q, K, EF) == fresh.search_live(q, K, EF)


def test_unlinking_hubs_hurts_more_than_random(tmp_path):
    data = clustered_dataset(
        n_vectors=500, n_queries=40, dim=DIM, n_clusters=4, seed=SEED, cluster_std=0.08
    )
    base = build(data.vectors)
    save_store(base, tmp_path / "store.bin")
    rand, hub = load_store(tmp_path / "store.bin"), load_store(tmp_path / "store.bin")

    order = np.random.default_rng(SEED).permutation(500)[:75]
    rand.unlink_many([int(n) for n in order])
    degrees = sorted(
        ((hub.layer0_degree(n), n) for n in hub.live_ids()),
        key=lambda pair: (-pair[0], pair[1]),
    )
    hub.unlink_many([n for _, n in degrees[:75]])

    assert hub.reachable_live_from_entry() <= rand.reachable_live_from_entry()
    assert mean_recall(hub, data.queries) <= mean_recall(rand, data.queries)
