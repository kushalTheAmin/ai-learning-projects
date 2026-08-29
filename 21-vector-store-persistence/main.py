"""Vector store persistence and incremental update, measured.

Five experiments on one seeded clustered dataset:

1. save/load fidelity: byte format sizes, search identity after a
   roundtrip, and why the RNG state is part of the state.
2. corruption: flipped bytes, truncation, wrong magic; all refused.
3. incremental growth vs rebuild-per-batch: what staying incremental
   saves, and what insertion order does to recall.
4. tombstone deletes: recall, result shortfall, wasted distance
   computations, and the compaction break-even.
5. unlinking hubs vs random nodes: how much graph damage hard deletes do,
   with tombstones as the control.

Everything is deterministic except wall-clock lines, which are labelled.
Distance computations are the portable cost unit, as in 13.
"""

import tempfile
import time
from pathlib import Path

import numpy as np

from vecstore import (
    MutableHnswIndex,
    StoreFormatError,
    ann_recall,
    clustered_dataset,
    load_store,
    mean,
    save_store,
    store_from_bytes,
    store_to_bytes,
)

SEED = 42
DIM = 32
N_BASE = 2000
N_FULL = 3000
N_CLUSTERS = 8
N_QUERIES = 150
K = 10
EF = 80
M = 16
EF_CONSTRUCTION = 100
DELETE_ORDER_SEED = 7


def build_index(vectors: np.ndarray, seed: int = SEED) -> MutableHnswIndex:
    index = MutableHnswIndex(
        dim=vectors.shape[1], m=M, ef_construction=EF_CONSTRUCTION, seed=seed
    )
    for row in vectors:
        index.add(row)
    return index


def live_recall(
    index: MutableHnswIndex, queries: np.ndarray, ef: int = EF
) -> tuple[float, int, float]:
    """(mean recall@K vs exact-over-live, queries short of K, graph distance
    computations per query)."""
    index.distance_count = 0
    recalls, shortfalls = [], 0
    for query in queries:
        found = index.search_live(query, K, ef)
        truth = index.exact_live_topk(query, K)
        recalls.append(ann_recall(found, truth, K))
        if len(found) < min(K, index.live_count):
            shortfalls += 1
    return mean(recalls), shortfalls, index.distance_count / len(queries)


def results_equal(
    a: list[list[tuple[int, float]]], b: list[list[tuple[int, float]]]
) -> int:
    return sum(1 for x, y in zip(a, b) if x == y)


def run_all_queries(
    index: MutableHnswIndex, queries: np.ndarray
) -> list[list[tuple[int, float]]]:
    return [index.search_live(q, K, EF) for q in queries]


def experiment_persistence(base: MutableHnswIndex, data, extra: np.ndarray) -> bytes:
    print("== 1. save/load fidelity ==")
    before = run_all_queries(base, data.queries)

    blob = store_to_bytes(base)
    with tempfile.TemporaryDirectory() as scratch:
        path = Path(scratch) / "store.bin"
        start = time.perf_counter()
        sizes = save_store(base, path)
        save_ms = (time.perf_counter() - start) * 1000
        start = time.perf_counter()
        loaded = load_store(path)
        load_ms = (time.perf_counter() - start) * 1000
    print(
        f"file: {sizes['total']} bytes total = header {sizes['header']} "
        f"+ vectors {sizes['vectors']} + links {sizes['links']} + framing/checksum "
        f"{sizes['total'] - sizes['header'] - sizes['vectors'] - sizes['links']}"
    )
    print(f"save {save_ms:.1f} ms, load {load_ms:.1f} ms (wall clock, approximate)")

    after = run_all_queries(loaded, data.queries)
    print(
        f"search identity after roundtrip: {results_equal(before, after)}/"
        f"{len(data.queries)} queries return identical (id, distance) lists"
    )

    grown_original = base.clone()
    for row in extra:
        grown_original.add(row)
    grown_loaded = loaded
    for row in extra:
        grown_loaded.add(row)
    cont = results_equal(
        run_all_queries(grown_original, data.queries),
        run_all_queries(grown_loaded, data.queries),
    )
    same_graph = (
        grown_original.export_state()["links"] == grown_loaded.export_state()["links"]
    )
    print(
        f"continued growth ({len(extra)} adds on both twins): graphs "
        f"{'identical' if same_graph else 'DIVERGED'}, {cont}/{len(data.queries)} "
        f"queries identical, the loaded index grows the same graph"
    )

    stale_state = base.export_state()
    stale_state["rng_state"] = np.random.default_rng(SEED).bit_generator.state
    stale = MutableHnswIndex.restore(stale_state)
    for row in extra:
        stale.add(row)
    level_diffs = sum(
        1
        for node in range(len(base), len(stale))
        if stale.node_level(node) != grown_original.node_level(node)
    )
    stale_graph_same = (
        stale.export_state()["links"] == grown_original.export_state()["links"]
    )
    stale_same = results_equal(
        run_all_queries(grown_original, data.queries), run_all_queries(stale, data.queries)
    )
    print(
        f"same adds with the RNG state reset instead of restored: level draws "
        f"differ on {level_diffs} of {len(extra)} new nodes, graphs "
        f"{'identical' if stale_graph_same else 'diverged'}; these "
        f"{len(data.queries)} queries still agree on {stale_same} "
        f"(a wide beam hides the difference, determinism is gone)"
    )
    print()
    return blob


def experiment_corruption(blob: bytes) -> None:
    print("== 2. corruption is refused ==")
    import struct

    (header_len,) = struct.unpack_from("<I", blob, 12)
    vectors_at = 12 + 4 + header_len + 8
    cases: list[tuple[str, bytes]] = []

    flipped = bytearray(blob)
    flipped[vectors_at + len(blob) // 4] ^= 0x01
    cases.append(("one bit flipped in the vectors section", bytes(flipped)))

    flipped = bytearray(blob)
    flipped[len(blob) - 40] ^= 0x01
    cases.append(("one bit flipped in the links section", bytes(flipped)))

    flipped = bytearray(blob)
    flipped[20] ^= 0x01
    cases.append(("one bit flipped in the header", bytes(flipped)))

    cases.append(("file truncated by 1000 bytes", blob[:-1000]))
    cases.append(("magic bytes overwritten", b"NOTSTORE" + blob[8:]))

    for label, corrupt in cases:
        try:
            store_from_bytes(corrupt)
            raise AssertionError(f"{label}: loaded without complaint")
        except StoreFormatError as err:
            print(f"{label}: refused ({err})")
    print()


def experiment_growth(vectors: np.ndarray, data) -> None:
    print("== 3. incremental growth vs rebuild per batch ==")
    schedule = [1000, 1500, 2000, 2500, 3000]
    grown = build_index(vectors[: schedule[0]])
    initial_cost = grown.distance_count
    print(f"initial build at {schedule[0]}: {initial_cost} distance computations")
    print("size | incremental adds | full rebuild | grown recall | fresh recall")

    incremental_total = initial_cost
    rebuild_total = initial_cost
    fresh = None
    for prev, size in zip(schedule, schedule[1:]):
        marker = grown.distance_count
        for row in vectors[prev:size]:
            grown.add(row)
        step_cost = grown.distance_count - marker
        incremental_total += step_cost

        fresh = build_index(vectors[:size])
        rebuild_cost = fresh.distance_count
        rebuild_total += rebuild_cost

        grown_recall, _, _ = live_recall(grown, data.queries)
        fresh_recall, _, _ = live_recall(fresh, data.queries)
        print(
            f"{size:4d} | {step_cost:16d} | {rebuild_cost:12d} | "
            f"{grown_recall:12.3f} | {fresh_recall:12.3f}"
        )

    identical = results_equal(
        run_all_queries(grown, data.queries), run_all_queries(fresh, data.queries)
    )
    print(
        f"grown vs fresh at {schedule[-1]} (same insert order, same seed): "
        f"{identical}/{len(data.queries)} queries identical, incremental insert "
        f"IS the build path"
    )
    print(
        f"cumulative graph cost, {schedule[0]} then batches of 500: incremental "
        f"{incremental_total} vs rebuild-per-batch {rebuild_total} "
        f"({rebuild_total / incremental_total:.2f}x)"
    )

    recalls = []
    for shuffle_seed in range(5):
        perm = np.random.default_rng(shuffle_seed).permutation(len(vectors))
        shuffled = build_index(vectors[perm])
        recall, _, _ = live_recall(shuffled, data.queries)
        recalls.append(recall)
    print(
        f"insertion-order sensitivity, 5 shuffled builds at {len(vectors)}: "
        f"recall min {min(recalls):.3f} / mean {mean(recalls):.3f} / "
        f"max {max(recalls):.3f}"
    )
    print()


def experiment_tombstones(base: MutableHnswIndex, queries: np.ndarray) -> None:
    print("== 4. tombstone deletes and the compaction break-even ==")
    print(
        "deleted | recall | short | dists/query | compacted: build, dists/query, "
        "recall | waste | break-even queries"
    )
    order = np.random.default_rng(DELETE_ORDER_SEED).permutation(len(base))
    work = base.clone()
    done = 0
    for fraction in (0.1, 0.3, 0.5, 0.7):
        target = int(fraction * len(base))
        for node in order[done:target]:
            work.delete(int(node))
        done = target

        recall, short, per_query = live_recall(work, queries)
        compacted, _ = work.compact(SEED)
        build_cost = compacted.distance_count
        c_recall, _, c_per_query = live_recall(compacted, queries)
        waste = per_query / c_per_query
        breakeven = build_cost / (per_query - c_per_query)
        print(
            f"{fraction:7.0%} | {recall:.3f} | {short:5d} | {per_query:11.1f} | "
            f"{build_cost:9d}, {c_per_query:7.1f}, {c_recall:.3f} | "
            f"{waste:.2f}x | {breakeven:9.0f}"
        )

    recall, short, per_query = live_recall(work, queries, ef=2 * EF)
    print(
        f"    70% again with ef doubled to {2 * EF}: recall {recall:.3f}, "
        f"short {short}, {per_query:.1f} dists/query"
    )
    print()


def experiment_unlink(
    base: MutableHnswIndex, vectors: np.ndarray, queries: np.ndarray
) -> None:
    print("== 5. hard unlink: hubs vs random, tombstones as control ==")
    print(
        "the fourth column is the same hub attack on a graph built with naive "
        "M-closest selection instead of the paper's heuristic (13's ablation): "
        "same vectors, same removals, different edges"
    )
    order = np.random.default_rng(DELETE_ORDER_SEED).permutation(len(base))
    naive_base = MutableHnswIndex(
        dim=base.dim, m=M, ef_construction=EF_CONSTRUCTION, seed=SEED, heuristic=False
    )
    for row in vectors[: len(base)]:
        naive_base.add(row)
    tomb, rand, hub, naive = base.clone(), base.clone(), base.clone(), naive_base

    def hub_batch(index: MutableHnswIndex, count: int) -> list[int]:
        degrees = sorted(
            ((index.layer0_degree(node), node) for node in index.live_ids()),
            key=lambda pair: (-pair[0], pair[1]),
        )
        return [node for _, node in degrees[:count]]

    def cells(indexes: list[MutableHnswIndex]) -> list[str]:
        out = []
        for index in indexes:
            recall, _, _ = live_recall(index, queries)
            reach = index.reachable_live_from_entry() / index.live_count
            out.append(f"{recall:.3f} / {reach:.3f}")
        return out

    print(
        "removed | tombstone      | random unlink  | hub unlink     | "
        "hub unlink on naive build"
    )
    row = cells([tomb, rand, hub, naive])
    print(f"   0 (  0%) | {row[0]} | {row[1]} | {row[2]} | {row[3]}")
    done = 0
    for count in (100, 200, 400, 600):
        batch = [int(node) for node in order[done:count]]
        for node in batch:
            tomb.delete(node)
        rand.unlink_many(batch)
        hub.unlink_many(hub_batch(hub, count - done))
        naive.unlink_many(hub_batch(naive, count - done))
        done = count
        row = cells([tomb, rand, hub, naive])
        print(
            f"{count:4d} ({count / len(base):4.0%}) | {row[0]} | {row[1]} | "
            f"{row[2]} | {row[3]}"
        )
    print()


def main() -> None:
    data = clustered_dataset(
        n_vectors=N_FULL,
        n_queries=N_QUERIES,
        dim=DIM,
        n_clusters=N_CLUSTERS,
        seed=SEED,
    )
    print(
        f"dataset: {N_FULL} clustered vectors ({N_CLUSTERS} clusters, dim {DIM}), "
        f"{N_QUERIES} queries, seed {SEED}"
    )
    print(
        f"index: m={M}, ef_construction={EF_CONSTRUCTION}, heuristic selection; "
        f"search k={K}, ef={EF}; base store holds the first {N_BASE} vectors"
    )
    print()

    base = build_index(data.vectors[:N_BASE])
    print(f"base build: {base.distance_count} distance computations")
    print()

    blob = experiment_persistence(base, data, data.vectors[N_BASE : N_BASE + 100])
    experiment_corruption(blob)
    experiment_growth(data.vectors, data)
    experiment_tombstones(base, data.queries)
    experiment_unlink(base, data.vectors, data.queries)


if __name__ == "__main__":
    main()
