"""Unlink-with-repair, measured against the attacks that exposed unlink.

main.py's section 5 showed hard removal without repair tearing the
naive-built graph apart (reachability 0.633 at 30% removed) while the
heuristic build held. This study runs the same attacks with a local patch
turned on: every in-neighbor of a removed node gains links into the removed
node's surviving out-neighborhood. Two patch policies, because they answer
differently:

- fill: keep every surviving edge, add bridge candidates only into the
  slots the removal freed. Strictly additive over plain unlinking.
- reselect: re-run neighbor selection over survivors and bridge candidates
  together under the degree cap, which can drop surviving edges.

Four questions, one per section:

1. how much of the hub-attack collapse does each patch buy back on the
   naive build, under each selection rule?
2. does the fill answer survive the degree tie-break draw (five seeds,
   min-max)?
3. the sharper attack: removing the 100 earliest inserts cut naive
   reachability to 0.639 with no repair. what does each patch do there?
4. what does repair cost in distance computations, against compact()'s
   full rebuild at the same point?

Everything is deterministic; distance computations are the portable cost
unit, as in 13 and main.py.
"""

import importlib.util
from pathlib import Path

import numpy as np

from vecstore import MutableHnswIndex, clustered_dataset

# load by path: sibling projects on sys.path also have a main.py
_spec = importlib.util.spec_from_file_location(
    "vecstore_main", Path(__file__).resolve().parent / "main.py"
)
_main = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_main)

SEED = _main.SEED
N_BASE = _main.N_BASE
M = _main.M
EF_CONSTRUCTION = _main.EF_CONSTRUCTION
UNLINK_STEPS = _main.UNLINK_STEPS
HUB_TIE_SEEDS = _main.HUB_TIE_SEEDS
EARLIEST_COUNT = 100

live_recall = _main.live_recall

Rows = list[tuple[float, float]]
Totals = dict[str, int]

VARIANTS: tuple[tuple[str, bool | None, bool], ...] = (
    ("fill, naive selection", False, False),
    ("fill, heuristic selection", True, False),
    ("reselect, naive selection", False, True),
    ("reselect, heuristic selection", True, True),
)


def repair_attack_rows(
    source: MutableHnswIndex,
    queries: np.ndarray,
    tie_seed: int,
    repair: bool,
    selection: bool | None = None,
    reselect: bool = False,
    steps: tuple[int, ...] = UNLINK_STEPS,
) -> tuple[Rows, Totals]:
    """Cumulative hub attack on a clone, batches by highest layer-0 degree
    with ties drawn from tie_seed, removal via unlink_with_repair when
    repair is set and plain unlink_many otherwise. Returns per-step
    (recall, live reachability) plus repair totals; repair_dists is
    captured per batch because live_recall zeroes the distance counter."""
    index = source.clone()
    rng = np.random.default_rng(tie_seed)
    rows: Rows = []
    totals = {
        "edges_lost": 0,
        "edges_added": 0,
        "edges_dropped": 0,
        "reselections": 0,
        "repair_dists": 0,
    }
    done = 0
    for count in steps:
        batch = index.highest_degree_live(count - done, rng)
        done = count
        if repair:
            marker = index.distance_count
            stats = index.unlink_with_repair(batch, heuristic=selection, reselect=reselect)
            totals["repair_dists"] += index.distance_count - marker
            for key in ("edges_lost", "edges_added", "edges_dropped", "reselections"):
                totals[key] += stats[key]
        else:
            index.unlink_many(batch)
        recall, _, _ = live_recall(index, queries)
        rows.append((recall, index.reachable_live_from_entry() / index.live_count))
    return rows, totals


def cell(row: tuple[float, float]) -> str:
    return f"{row[0]:.3f} / {row[1]:.3f}"


def experiment_hub_repair(
    naive: MutableHnswIndex, queries: np.ndarray
) -> dict[str, tuple[Rows, Totals]]:
    print("== 1. hub attack on the naive build, patched vs bare ==")
    runs: dict[str, tuple[Rows, Totals]] = {
        "no repair": repair_attack_rows(naive, queries, HUB_TIE_SEEDS[0], repair=False)
    }
    for label, selection, reselect in VARIANTS:
        runs[label] = repair_attack_rows(
            naive, queries, HUB_TIE_SEEDS[0], repair=True,
            selection=selection, reselect=reselect,
        )
    print(f"recall / live reachability at tie seed {HUB_TIE_SEEDS[0]}")
    print(
        "removed | no repair     | fill naive    | fill heuristic | "
        "resel naive   | resel heuristic"
    )
    for step, count in enumerate(UNLINK_STEPS):
        cells = " | ".join(
            cell(runs[label][0][step])
            for label in ("no repair", *(label for label, _, _ in VARIANTS))
        )
        print(f"{count:4d} ({count / len(naive):4.0%}) | {cells}")
    for label, _, _ in VARIANTS:
        totals = runs[label][1]
        print(
            f"{label}: {totals['edges_lost']} edges lost, "
            f"{totals['edges_added']} added, {totals['edges_dropped']} surviving "
            f"edges dropped, {totals['repair_dists']} repair distance computations"
        )
    print()
    return runs


def experiment_tie_spread(naive: MutableHnswIndex, queries: np.ndarray) -> None:
    print("== 2. bare vs fill over five degree tie draws (min-max) ==")
    bare = [
        repair_attack_rows(naive, queries, seed, repair=False)[0]
        for seed in HUB_TIE_SEEDS
    ]
    fill_naive = [
        repair_attack_rows(naive, queries, seed, repair=True, selection=False)[0]
        for seed in HUB_TIE_SEEDS
    ]
    fill_heuristic = [
        repair_attack_rows(naive, queries, seed, repair=True, selection=True)[0]
        for seed in HUB_TIE_SEEDS
    ]
    print(
        "removed | bare recall   | bare reach    | fill-n recall | fill-n reach  | "
        "fill-h recall | fill-h reach"
    )
    for step, count in enumerate(UNLINK_STEPS):

        def span(all_rows: list[Rows], column: int) -> str:
            values = [rows[step][column] for rows in all_rows]
            return f"{min(values):.3f}-{max(values):.3f}"

        print(
            f"{count:7d} | {span(bare, 0)} | {span(bare, 1)} | "
            f"{span(fill_naive, 0)} | {span(fill_naive, 1)} | "
            f"{span(fill_heuristic, 0)} | {span(fill_heuristic, 1)}"
        )
    print()


def experiment_earliest(
    naive: MutableHnswIndex, heuristic: MutableHnswIndex, queries: np.ndarray
) -> None:
    print(
        f"== 3. the earliest-inserts attack (ids 0..{EARLIEST_COUNT - 1}), "
        f"patched vs bare =="
    )
    batch = list(range(EARLIEST_COUNT))
    cases: tuple[tuple[str, bool, bool], ...] = (
        ("no repair", False, False),
        ("fill", True, False),
        ("reselect", True, True),
    )
    for build_label, source in (("naive build", naive), ("heuristic build", heuristic)):
        for label, repair, reselect in cases:
            index = source.clone()
            marker = index.distance_count
            if repair:
                stats = index.unlink_with_repair(batch, reselect=reselect)
            else:
                stats = None
                index.unlink_many(batch)
            repair_dists = index.distance_count - marker
            recall, _, _ = live_recall(index, queries)
            reach = index.reachable_live_from_entry() / index.live_count
            cost = (
                f", {stats['edges_lost']} edges lost / {stats['edges_added']} "
                f"added, {repair_dists} repair dists"
                if stats is not None
                else ""
            )
            print(
                f"{build_label}, {label} (build's own selection): recall "
                f"{recall:.3f}, reachability {reach:.3f}{cost}"
            )
    print()


def experiment_cost(
    naive: MutableHnswIndex,
    queries: np.ndarray,
    runs: dict[str, tuple[Rows, Totals]],
) -> None:
    print("== 4. what repair costs, against the full rebuild ==")
    removed = UNLINK_STEPS[-1]
    torn = naive.clone()
    rng = np.random.default_rng(HUB_TIE_SEEDS[0])
    torn.unlink_many(torn.highest_degree_live(removed, rng))
    compacted, _ = torn.compact(SEED)
    rebuild_cost = compacted.distance_count
    c_recall, _, _ = live_recall(compacted, queries)
    c_reach = compacted.reachable_live_from_entry() / compacted.live_count
    print(
        f"compact() after the {removed}-node hub attack: {rebuild_cost} build "
        f"distance computations, recall {c_recall:.3f}, reachability {c_reach:.3f}"
    )
    for label, _, _ in VARIANTS:
        rows, totals = runs[label]
        share = totals["repair_dists"] / rebuild_cost
        print(
            f"{label}: {totals['repair_dists']} repair dists over {removed} "
            f"removals = {totals['repair_dists'] / removed:.0f} per removed node "
            f"({share:.1%} of the rebuild), ends at recall {rows[-1][0]:.3f} / "
            f"reachability {rows[-1][1]:.3f}"
        )
    print()


def main() -> None:
    data = clustered_dataset(
        n_vectors=_main.N_FULL,
        n_queries=_main.N_QUERIES,
        dim=_main.DIM,
        n_clusters=_main.N_CLUSTERS,
        seed=SEED,
    )
    print(
        f"dataset and index parameters as in main.py: first {N_BASE} clustered "
        f"vectors, m={M}, ef_construction={EF_CONSTRUCTION}, "
        f"search k={_main.K}, ef={_main.EF}"
    )
    naive = MutableHnswIndex(
        dim=_main.DIM, m=M, ef_construction=EF_CONSTRUCTION, seed=SEED, heuristic=False
    )
    heuristic = MutableHnswIndex(
        dim=_main.DIM, m=M, ef_construction=EF_CONSTRUCTION, seed=SEED, heuristic=True
    )
    for row in data.vectors[:N_BASE]:
        naive.add(row)
        heuristic.add(row)
    print(
        f"naive build: {naive.distance_count} distance computations, "
        f"heuristic build: {heuristic.distance_count}"
    )
    print()

    runs = experiment_hub_repair(naive, data.queries)
    experiment_tie_spread(naive, data.queries)
    experiment_earliest(naive, heuristic, data.queries)
    experiment_cost(naive, data.queries, runs)


if __name__ == "__main__":
    main()
