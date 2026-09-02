"""unlink_with_repair: the local patch, both policies, held to its contract.

The fill policy must be strictly additive over plain unlinking; reselect is
allowed to drop surviving edges but must say so in its stats. Topology
tests run on hand-authored graphs restored from explicit link lists, so
the shape under test is exactly the shape written down.
"""

import importlib.util
from pathlib import Path

import numpy as np
import pytest

from vecstore import MutableHnswIndex, clustered_dataset

_ROOT = Path(__file__).resolve().parents[1]


def _load_by_path(name: str):
    # load by path: sibling projects on sys.path also have same-named modules
    spec = importlib.util.spec_from_file_location(f"vecstore_{name}", _ROOT / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def authored_index(
    vectors: list[list[float]],
    links: list[list[list[int]]],
    entry: int,
    m: int = 2,
    heuristic: bool = False,
) -> MutableHnswIndex:
    """An index whose graph is exactly the given link lists."""
    return MutableHnswIndex.restore(
        {
            "dim": len(vectors[0]),
            "m": m,
            "ef_construction": 10,
            "heuristic": heuristic,
            "size": len(vectors),
            "entry": entry,
            "max_level": max(len(layers) for layers in links) - 1,
            "deleted": [],
            "rng_state": np.random.default_rng(0).bit_generator.state,
            "distance_count": 0,
            "vectors": np.array(vectors, dtype=np.float64),
            "links": links,
        }
    )


@pytest.fixture(scope="module")
def naive_index() -> MutableHnswIndex:
    data = clustered_dataset(n_vectors=300, n_queries=1, dim=8, n_clusters=4, seed=3)
    index = MutableHnswIndex(dim=8, m=8, ef_construction=40, seed=3, heuristic=False)
    for row in data.vectors:
        index.add(row)
    return index


@pytest.fixture(scope="module")
def hub_batch(naive_index) -> list[int]:
    return naive_index.highest_degree_live(60, np.random.default_rng(0))


class TestTopology:
    def test_fill_bridges_a_cut_chain(self):
        """0 - 1 - 2 on a line; unlinking 1 severs 2, the patch reconnects it."""
        chain = authored_index(
            [[0.0], [1.0], [2.0]], [[[1]], [[0, 2]], [[1]]], entry=0
        )
        bare = chain.clone()
        bare.unlink(1)
        assert bare.reachable_live_from_entry() == 1

        stats = chain.unlink_with_repair([1])
        assert chain.reachable_live_from_entry() == 2
        assert chain.neighbors(0, 0) == [2]
        assert chain.neighbors(2, 0) == [0]
        assert stats == {
            "edges_lost": 2,
            "edges_added": 2,
            "edges_dropped": 0,
            "reselections": 2,
        }

    def test_the_patch_is_one_hop_only(self):
        """0 - 1 - 2 - 3: removing 1 and 2 together leaves no survivor bridge
        (each doomed node's surviving out-neighborhood excludes the other),
        so 3 stays severed. The patch cannot route through the batch."""
        line = authored_index(
            [[0.0], [1.0], [2.0], [3.0]],
            [[[1]], [[0, 2]], [[1, 3]], [[2]]],
            entry=0,
        )
        stats = line.unlink_with_repair([1, 2])
        assert line.reachable_live_from_entry() == 1
        assert line.neighbors(0, 0) == []
        assert stats["edges_added"] == 0

    def test_reselect_drops_a_far_surviving_edge_and_fill_does_not(self):
        """Survivor 0 sits at the layer-0 cap (m0 = 4) with one edge to the
        far node 5. Removing node 1 frees one slot and offers two bridge
        candidates closer than everything kept. Fill keeps every surviving
        edge and adds the nearest bridge into the freed slot; reselect ranks
        survivors and bridges together and drops the far edge."""
        vectors = [[0.0], [1.0], [2.0], [3.0], [4.0], [100.0], [0.1], [0.2]]
        links = [
            [[1, 2, 3, 5]],  # 0: at cap, one long-range edge to 5
            [[0, 6, 7]],
            [[0]],
            [[0]],
            [[]],
            [[0]],
            [[1]],
            [[1]],
        ]
        fill = authored_index(vectors, links, entry=0)
        resel = fill.clone()

        fill_stats = fill.unlink_with_repair([1])
        assert fill.neighbors(0, 0) == [2, 3, 5, 6]
        assert fill_stats["edges_dropped"] == 0

        resel_stats = resel.unlink_with_repair([1], reselect=True)
        assert set(resel.neighbors(0, 0)) == {6, 7, 2, 3}
        assert resel_stats["edges_dropped"] == 1

    def test_doomed_entry_is_reset(self):
        star = authored_index(
            [[0.0], [1.0], [2.0]], [[[1, 2]], [[0]], [[0]]], entry=0
        )
        star.unlink_with_repair([0])
        assert star._entry in (1, 2)
        assert star.reachable_live_from_entry() >= 1


class TestContract:
    def test_fill_is_additive_over_plain_unlink(self, naive_index, hub_batch):
        plain = naive_index.clone()
        plain.unlink_many(hub_batch)
        patched = naive_index.clone()
        patched.unlink_with_repair(hub_batch)
        for node in range(len(plain)):
            plain_layers = plain.export_state()["links"][node]
            patched_layers = patched.export_state()["links"][node]
            for bare_ids, fill_ids in zip(plain_layers, patched_layers):
                assert set(bare_ids) <= set(fill_ids)

    def test_no_doomed_ids_no_self_links_no_duplicates_caps_hold(
        self, naive_index, hub_batch
    ):
        for reselect in (False, True):
            index = naive_index.clone()
            index.unlink_with_repair(hub_batch, reselect=reselect)
            doomed = set(hub_batch)
            for node in range(len(index)):
                for layer, ids in enumerate(index.export_state()["links"][node]):
                    assert not doomed & set(ids)
                    assert node not in ids
                    assert len(ids) == len(set(ids))
                    cap = index.m0 if layer == 0 else index.m
                    assert len(ids) <= cap

    def test_heuristic_fill_recovers_reachability_here(self, naive_index, hub_batch):
        """The binding claim: on this fixture the additive patch with
        heuristic selection reconnects most of what the bare unlink severs."""
        bare = naive_index.clone()
        bare.unlink_many(hub_batch)
        patched = naive_index.clone()
        patched.unlink_with_repair(hub_batch, heuristic=True)
        assert bare.reachable_live_from_entry() < 60
        assert patched.reachable_live_from_entry() > 200

    def test_stats_match_the_graphs(self, naive_index, hub_batch):
        before = naive_index.export_state()["links"]
        doomed = set(hub_batch)
        index = naive_index.clone()
        stats = index.unlink_with_repair(hub_batch)
        after = index.export_state()["links"]
        lost = sum(
            sum(1 for x in ids if x in doomed)
            for node, layers in enumerate(before)
            if node not in doomed
            for ids in layers
        )
        added = sum(
            len(set(after_ids) - set(before_ids))
            for node, (before_layers, after_layers) in enumerate(zip(before, after))
            if node not in doomed
            for before_ids, after_ids in zip(before_layers, after_layers)
        )
        assert stats["edges_lost"] == lost
        assert stats["edges_added"] == added
        assert stats["edges_dropped"] == 0

    def test_repair_pays_into_distance_count(self, naive_index, hub_batch):
        index = naive_index.clone()
        marker = index.distance_count
        index.unlink_with_repair(hub_batch)
        assert index.distance_count > marker

    def test_deterministic_across_clones(self, naive_index, hub_batch):
        first = naive_index.clone()
        second = naive_index.clone()
        assert first.unlink_with_repair(hub_batch, heuristic=True) == \
            second.unlink_with_repair(hub_batch, heuristic=True)
        assert first.export_state()["links"] == second.export_state()["links"]

    def test_search_still_answers_after_repair(self, naive_index, hub_batch):
        index = naive_index.clone()
        index.unlink_with_repair(hub_batch)
        query = np.full(8, 0.5)
        results = index.search_live(query, 5, 40)
        assert 0 < len(results) <= 5
        assert all(not index.is_deleted(node) for node, _ in results)


class TestValidation:
    def test_empty_batch_is_a_no_op(self, naive_index):
        index = naive_index.clone()
        before = index.export_state()["links"]
        stats = index.unlink_with_repair([])
        assert stats == {
            "edges_lost": 0,
            "edges_added": 0,
            "edges_dropped": 0,
            "reselections": 0,
        }
        assert index.export_state()["links"] == before

    def test_already_deleted_is_refused(self, naive_index):
        index = naive_index.clone()
        index.delete(3)
        with pytest.raises(ValueError, match="already deleted"):
            index.unlink_with_repair([3])

    def test_duplicate_in_batch_is_refused(self, naive_index):
        index = naive_index.clone()
        with pytest.raises(ValueError, match="twice"):
            index.unlink_with_repair([1, 2, 1])

    def test_out_of_range_is_refused(self, naive_index):
        index = naive_index.clone()
        with pytest.raises(ValueError, match="out of range"):
            index.unlink_with_repair([len(index)])

    def test_refused_batch_changes_nothing(self, naive_index):
        index = naive_index.clone()
        before = index.export_state()["links"]
        with pytest.raises(ValueError):
            index.unlink_with_repair([1, 2, 2])
        assert index.export_state()["links"] == before
        assert index.deleted_count == 0


@pytest.fixture(scope="module")
def study():
    return _load_by_path("repair_main")


class TestStudyRunner:
    def test_attack_rows_deterministic_and_source_untouched(self, study, naive_index):
        queries = np.random.default_rng(5).uniform(0.0, 1.0, size=(6, 8))
        steps = (20, 40)
        first = study.repair_attack_rows(
            naive_index, queries, 0, repair=True, selection=True, steps=steps
        )
        second = study.repair_attack_rows(
            naive_index, queries, 0, repair=True, selection=True, steps=steps
        )
        assert first == second
        assert len(first[0]) == len(steps)
        assert naive_index.deleted_count == 0

    def test_fill_runs_report_no_dropped_edges(self, study, naive_index):
        queries = np.random.default_rng(5).uniform(0.0, 1.0, size=(4, 8))
        _, totals = study.repair_attack_rows(
            naive_index, queries, 0, repair=True, selection=False, steps=(30,)
        )
        assert totals["edges_dropped"] == 0
        assert totals["edges_added"] > 0
        assert totals["repair_dists"] > 0
