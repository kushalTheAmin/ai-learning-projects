"""Exact vs HNSW: recall against distance computations.

Everything here is deterministic except the wall-clock columns, which are
labelled and move a few percent run to run. Distance computations are the
portable cost unit: they count base-vector comparisons, which is what both
indexes fundamentally spend.
"""

import time

from ann.dataset import Dataset, clustered_dataset, uniform_dataset
from ann.exact import ExactIndex
from ann.hnsw import HnswIndex
from ann.reuse import ann_recall, mean

SEED = 42
K = 10


def build_exact(data: Dataset) -> ExactIndex:
    index = ExactIndex(dim=data.vectors.shape[1])
    for row in data.vectors:
        index.add(row)
    return index


def build_hnsw(data: Dataset, m: int, ef_construction: int, heuristic: bool) -> HnswIndex:
    index = HnswIndex(
        dim=data.vectors.shape[1],
        m=m,
        ef_construction=ef_construction,
        seed=SEED,
        heuristic=heuristic,
    )
    for row in data.vectors:
        index.add(row)
    return index


def ground_truth(data: Dataset) -> list[list[tuple[int, float]]]:
    index = build_exact(data)
    return [index.search(q, K) for q in data.queries]


def sweep_row(
    index: HnswIndex, data: Dataset, truth: list[list[tuple[int, float]]], ef: int
) -> tuple[float, float, float]:
    """(recall@K, distance computations per query, wall ms per query)."""
    index.distance_count = 0
    start = time.perf_counter()
    results = [index.search(q, K, ef=ef) for q in data.queries]
    elapsed = time.perf_counter() - start
    n_queries = len(data.queries)
    recall = mean([ann_recall(res, exact, K) for res, exact in zip(results, truth)])
    return recall, index.distance_count / n_queries, elapsed * 1000 / n_queries


def miss_attribution(
    index: HnswIndex, data: Dataset, truth: list[list[tuple[int, float]]], ef: int
) -> tuple[int, int, int, int, list[int]]:
    """Splits missed gold neighbors two ways and reports where the walks began.

    A search descends the upper layers first, so its layer-0 beam starts at
    `layer0_entry(query)`, not at the top-layer entry point. Against that
    start, a miss is either a node no layer-0 walk from there could reach or
    one the beam could have reached and settled short of.

    Returns (gold slots, unreachable misses, in-reach misses, distinct layer-0
    starts, sorted sizes of the components those starts sit in)."""
    closures: dict[int, set[int]] = {}
    slots = unreachable = in_reach = 0
    for query, exact in zip(data.queries, truth):
        start = index.layer0_entry(query)
        if start not in closures:
            closures[start] = index.reachable_from_on_layer0(start)
        found = {node for node, _ in index.search(query, K, ef=ef)}
        for node, _ in exact:
            slots += 1
            if node in found:
                continue
            if node in closures[start]:
                in_reach += 1
            else:
                unreachable += 1
    return slots, unreachable, in_reach, len(closures), sorted(
        {len(reach) for reach in closures.values()}
    )


def miss_attribution_block(
    index: HnswIndex,
    data: Dataset,
    truth: list[list[tuple[int, float]]],
    ef: int,
    n: int,
) -> list[str]:
    """The attribution as printed lines, returned rather than printed so a
    test can pin the readme against them without rerunning the whole file."""
    slots, unreachable, in_reach, starts, sizes = miss_attribution(index, data, truth, ef)
    return [
        "layer-0 walks start at the descent endpoint, not the entry point:",
        f"  {starts} distinct starts over {len(data.queries)} queries, in components "
        f"of {' / '.join(str(size) for size in sizes)}",
        f"  the entry point's own component is {index.reachable_on_layer0()} of {n}",
        f"{slots} gold slots, {unreachable + in_reach} missed:",
        f"  {unreachable} unreachable from that query's own layer-0 start",
        f"  {in_reach} inside reach, the beam never walked there",
    ]


def main() -> None:
    n, n_queries, dim, clusters = 3000, 150, 32, 24
    data = clustered_dataset(n, n_queries, dim, clusters, seed=SEED)
    truth = ground_truth(data)
    print("== dataset ==")
    print(
        f"{n} base vectors, {n_queries} queries, dim {dim}, "
        f"{clusters} gaussian clusters, seed {SEED}"
    )
    print(f"exact baseline: {n} distance computations per query, recall 1.000\n")

    # -- ef sweep -----------------------------------------------------------
    m, ef_construction = 16, 100
    index = build_hnsw(data, m=m, ef_construction=ef_construction, heuristic=True)
    build_dists = index.distance_count
    levels = index.level_counts()
    degrees = index.degrees(0)
    print(f"== build (M={m}, efConstruction={ef_construction}, heuristic) ==")
    print(f"build distance computations: {build_dists} ({build_dists / n:.0f} per vector)")
    print(f"nodes per top level, bottom up: {levels}")
    print(f"layer-0 degree: mean {mean(degrees):.1f}, max {max(degrees)}")
    print(f"layer-0 reachable from the entry point: {index.reachable_on_layer0()} of {n}\n")

    print(f"== ef sweep (M={m}, k={K}) ==")
    print("ef     recall@10   dists/query   vs exact    wall ms/query (varies)")
    for ef in (10, 20, 40, 80, 160, 320):
        recall, dists, ms = sweep_row(index, data, truth, ef)
        print(f"{ef:<6} {recall:<11.3f} {dists:<13.0f} {n / dists:<11.1f} {ms:.2f}")
    print()

    # -- M sweep ------------------------------------------------------------
    print(f"== M sweep (ef=32, efConstruction={ef_construction}, heuristic, k={K}) ==")
    print("M      recall@10   dists/query   build dists/vector")
    for m_value in (4, 8, 16, 32):
        swept = build_hnsw(data, m=m_value, ef_construction=ef_construction, heuristic=True)
        per_vector = swept.distance_count / n
        recall, dists, _ = sweep_row(swept, data, truth, ef=32)
        print(f"{m_value:<6} {recall:<11.3f} {dists:<13.0f} {per_vector:.0f}")
    print()

    # -- neighbor selection ablation ----------------------------------------
    ab_n, ab_queries, ab_m = 2000, 150, 8
    print(f"== neighbor selection ablation (M={ab_m}, ef=32, k={K}) ==")
    print("dataset            selection   recall@10   dists/query   layer-0 reachable")
    naive_tight: tuple[HnswIndex, Dataset, list[list[tuple[int, float]]]] | None = None
    for label, ab_data in (
        ("tight clusters", clustered_dataset(ab_n, ab_queries, dim, 32, seed=SEED, cluster_std=0.06)),
        ("uniform", uniform_dataset(ab_n, ab_queries, dim, seed=SEED)),
    ):
        ab_truth = ground_truth(ab_data)
        for heuristic in (True, False):
            ab_index = build_hnsw(ab_data, m=ab_m, ef_construction=100, heuristic=heuristic)
            recall, dists, _ = sweep_row(ab_index, ab_data, ab_truth, ef=32)
            name = "heuristic" if heuristic else "naive"
            reach = ab_index.reachable_on_layer0()
            print(
                f"{label:<18} {name:<11} {recall:<11.3f} {dists:<13.0f} "
                f"{reach} of {ab_n}"
            )
            if label == "tight clusters" and not heuristic:
                naive_tight = (ab_index, ab_data, ab_truth)
    print()

    # -- what the naive row's recall drop is made of ------------------------
    assert naive_tight is not None
    ab_index, ab_data, ab_truth = naive_tight
    print(f"== naive on tight clusters: what the misses are (M={ab_m}, ef=32, k={K}) ==")
    for line in miss_attribution_block(ab_index, ab_data, ab_truth, ef=32, n=ab_n):
        print(line)
    print()

    # -- wall clock reality check -------------------------------------------
    start = time.perf_counter()
    for q in data.queries:
        index.search(q, K, ef=32)
    hnsw_ms = (time.perf_counter() - start) * 1000 / n_queries
    exact_index = build_exact(data)
    start = time.perf_counter()
    for q in data.queries:
        exact_index.search(q, K)
    exact_ms = (time.perf_counter() - start) * 1000 / n_queries
    print("== wall clock at n=3000 (one run, varies) ==")
    print(f"hnsw ef=32: {hnsw_ms:.3f} ms/query   exact vectorized scan: {exact_ms:.3f} ms/query")
    print(
        "hnsw computes ~15x fewer distances at ef=32 but the wall-clock ratio\n"
        "is nowhere near 15x: the exact scan is one vectorized numpy pass while\n"
        "hnsw pays python-level overhead per visited node. distance computations\n"
        "are the portable number; this ratio is a property of the runtime."
    )


if __name__ == "__main__":
    main()
