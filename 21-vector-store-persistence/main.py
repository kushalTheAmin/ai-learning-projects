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
   with tombstones as the control, over five draws of the degree tie-break.

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
UNLINK_STEPS = (100, 200, 400, 600)
HUB_TIE_SEEDS = (0, 1, 2, 3, 4)


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


def hub_attack_rows(
    source: MutableHnswIndex,
    queries: np.ndarray,
    tie_seed: int,
    steps: tuple[int, ...] = UNLINK_STEPS,
) -> list[tuple[float, float]]:
    """(recall, live reachability) after each cumulative batch of the
    highest-layer-0-degree attack, degree ties drawn from tie_seed. Works on
    a clone; the source index is left alone."""
    index = source.clone()
    rng = np.random.default_rng(tie_seed)
    rows, done = [], 0
    for count in steps:
        index.unlink_many(index.highest_degree_live(count - done, rng))
        done = count
        recall, _, _ = live_recall(index, queries)
        rows.append((recall, index.reachable_live_from_entry() / index.live_count))
    return rows


def experiment_unlink(
    base: MutableHnswIndex, vectors: np.ndarray, queries: np.ndarray
) -> None:
    print("== 5. hard unlink: hubs vs random, tombstones as control ==")
    print(
        "the fourth column is the same hub attack on a graph built with naive "
        "M-closest selection instead of the paper's heuristic (13's ablation): "
        "same vectors, same attack, different edges"
    )
    order = np.random.default_rng(DELETE_ORDER_SEED).permutation(len(base))
    naive_base = MutableHnswIndex(
        dim=base.dim, m=M, ef_construction=EF_CONSTRUCTION, seed=SEED, heuristic=False
    )
    for row in vectors[: len(base)]:
        naive_base.add(row)
    tomb, rand = base.clone(), base.clone()

    def at_cap(index: MutableHnswIndex) -> int:
        return sum(1 for node in range(len(index)) if index.layer0_degree(node) == index.m0)

    print(
        f"layer-0 degree caps at {base.m0}, where {at_cap(base)} of {len(base)} "
        f"heuristic nodes and {at_cap(naive_base)} of {len(naive_base)} naive nodes "
        f"already sit, so ranking by degree leaves a tie group bigger than any "
        f"batch below: the hub columns break those ties on a seed, because "
        f"breaking them on the node id would remove the earliest inserts instead"
    )

    heuristic_runs = [hub_attack_rows(base, queries, seed) for seed in HUB_TIE_SEEDS]
    naive_runs = [hub_attack_rows(naive_base, queries, seed) for seed in HUB_TIE_SEEDS]

    def cell(index: MutableHnswIndex) -> str:
        recall, _, _ = live_recall(index, queries)
        return f"{recall:.3f} / {index.reachable_live_from_entry() / index.live_count:.3f}"

    print(
        f"recall / live reachability, hub columns at tie seed {HUB_TIE_SEEDS[0]}"
    )
    print(
        "removed | tombstone      | random unlink  | hub unlink     | "
        "hub unlink on naive build"
    )
    start, naive_start = cell(tomb), cell(naive_base)
    print(f"   0 (  0%) | {start} | {start} | {start} | {naive_start}")
    done = 0
    for step, count in enumerate(UNLINK_STEPS):
        batch = [int(node) for node in order[done:count]]
        for node in batch:
            tomb.delete(node)
        rand.unlink_many(batch)
        done = count
        hub_recall, hub_reach = heuristic_runs[0][step]
        naive_recall, naive_reach = naive_runs[0][step]
        print(
            f"{count:4d} ({count / len(base):4.0%}) | {cell(tomb)} | {cell(rand)} | "
            f"{hub_recall:.3f} / {hub_reach:.3f} | {naive_recall:.3f} / {naive_reach:.3f}"
        )

    print(
        f"the tie draw is arbitrary, so both hub columns over tie seeds "
        f"{HUB_TIE_SEEDS[0]}..{HUB_TIE_SEEDS[-1]} (min-max):"
    )
    print("removed | hub recall    | hub reach     | naive recall  | naive reach")
    for step, count in enumerate(UNLINK_STEPS):
        def span(runs: list[list[tuple[float, float]]], column: int) -> str:
            values = [run[step][column] for run in runs]
            return f"{min(values):.3f}-{max(values):.3f}"

        print(
            f"{count:7d} | {span(heuristic_runs, 0)} | {span(heuristic_runs, 1)} | "
            f"{span(naive_runs, 0)} | {span(naive_runs, 1)}"
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
