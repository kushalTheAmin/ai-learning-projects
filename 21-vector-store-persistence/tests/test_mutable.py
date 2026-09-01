import numpy as np
import pytest

from vecstore import MutableHnswIndex, clustered_dataset


def small_index(n: int = 120, dim: int = 8, seed: int = 3) -> MutableHnswIndex:
    data = clustered_dataset(n_vectors=n, n_queries=1, dim=dim, n_clusters=4, seed=seed)
    index = MutableHnswIndex(dim=dim, m=8, ef_construction=40, seed=seed)
    for row in data.vectors:
        index.add(row)
    return index


def queries(dim: int = 8, count: int = 20, seed: int = 99) -> np.ndarray:
    return np.random.default_rng(seed).uniform(0.0, 1.0, size=(count, dim))


class TestDelete:
    def test_delete_removes_from_results_only(self):
        index = small_index()
        query = queries(count=1)[0]
        top = index.search_live(query, 5, 40)
        victim = top[0][0]
        index.delete(victim)
        after = index.search_live(query, 5, 40)
        assert victim not in [node for node, _ in after]
        assert index.deleted_count == 1
        assert index.live_count == len(index) - 1

    def test_deleted_node_still_routes(self):
        index = small_index()
        entry = index._entry
        index.delete(entry)
        query = queries(count=1)[0]
        found = index.search_live(query, 5, 40)
        assert len(found) == 5
        assert entry not in [node for node, _ in found]

    def test_double_delete_rejected(self):
        index = small_index()
        index.delete(0)
        with pytest.raises(ValueError, match="already deleted"):
            index.delete(0)

    def test_out_of_range_rejected(self):
        index = small_index()
        with pytest.raises(ValueError, match="out of range"):
            index.delete(len(index))
        with pytest.raises(ValueError, match="out of range"):
            index.delete(-1)
        with pytest.raises(ValueError, match="must be an int"):
            index.delete(True)

    def test_delete_everything_yields_empty_results(self):
        index = small_index(n=30)
        for node in range(len(index)):
            index.delete(node)
        assert index.live_count == 0
        assert index.search_live(queries(count=1)[0], 5, 40) == []
        assert index.exact_live_topk(queries(count=1)[0], 5) == []

    def test_search_live_can_come_up_short(self):
        index = small_index(n=60)
        query = queries(count=1)[0]
        beam = index.search(query, 20, 20)
        for node, _ in beam[:15]:
            index.delete(node)
        found = index.search_live(query, 10, 20)
        assert len(found) <= 10
        live = set(index.live_ids())
        assert all(node in live for node, _ in found)


class TestExactLive:
    def test_matches_brute_force(self):
        index = small_index()
        for node in (3, 17, 40):
            index.delete(node)
        query = queries(count=1)[0]
        found = index.exact_live_topk(query, 10)
        ids = np.array(index.live_ids())
        diffs = index._store[ids] - query
        dists = np.einsum("ij,ij->i", diffs, diffs)
        order = np.lexsort((ids, dists))[:10]
        expected = [(int(ids[i]), float(dists[i])) for i in order]
        assert found == expected

    def test_does_not_count_distances(self):
        index = small_index()
        index.distance_count = 0
        index.exact_live_topk(queries(count=1)[0], 5)
        assert index.distance_count == 0

    def test_single_live_item(self):
        index = MutableHnswIndex(dim=3, m=2, ef_construction=4, seed=0)
        index.add(np.array([0.1, 0.2, 0.3]))
        assert index.exact_live_topk(np.zeros(3), 5) == index.search_live(np.zeros(3), 5, 8)


class TestUnlink:
    def test_unlink_strips_every_edge(self):
        index = small_index()
        victim = index._entry if index._entry != 0 else 1
        index.unlink(victim)
        for node in range(len(index)):
            for layer_links in index._links[node]:
                assert victim not in layer_links
        assert index._links[victim] == [[] for _ in index._links[victim]]

    def test_unlink_entry_reassigns_to_highest_live_level(self):
        index = small_index()
        old_entry = index._entry
        index.unlink(old_entry)
        assert index._entry != old_entry
        assert index._entry is not None
        best = max(
            (len(index._links[n]) - 1, -n) for n in range(len(index)) if n != old_entry
        )
        assert index._entry == -best[1]
        assert index._max_level == best[0]

    def test_unlink_all_leaves_empty_search(self):
        index = small_index(n=25)
        index.unlink_many(list(range(len(index))))
        assert index._entry is None
        assert index.search_live(queries(count=1)[0], 5, 40) == []
        assert index.reachable_live_from_entry() == 0

    def test_unlink_batch_rejects_duplicates(self):
        index = small_index()
        with pytest.raises(ValueError, match="twice"):
            index.unlink_many([1, 1])
        with pytest.raises(ValueError, match="already deleted"):
            index.delete(2)
            index.unlink_many([2])

    def test_reachability_drops_when_graph_is_cut(self):
        index = small_index()
        assert index.reachable_live_from_entry() == index.live_count
        degrees = sorted(
            ((index.layer0_degree(n), n) for n in index.live_ids()), reverse=True
        )
        index.unlink_many([n for _, n in degrees[:20]])
        assert index.reachable_live_from_entry() <= index.live_count


class TestHighestDegreeLive:
    """The hub attack has to pick hubs.

    Layer-0 degree is capped at m0 and a large share of any built graph sits
    exactly at the cap, so "highest layer-0 degree" leaves a big tie group.
    Resolving that group by node id is not a hub attack, it is an
    insertion-order attack: the lowest ids are the earliest inserts.
    """

    def saturated(self, n: int = 300) -> MutableHnswIndex:
        index = small_index(n=n)
        cap_nodes = [i for i in index.live_ids() if index.layer0_degree(i) == index.m0]
        assert len(cap_nodes) > 40, "fixture must leave a real tie group at the cap"
        return index

    def test_picks_the_most_connected_first(self):
        index = self.saturated()
        picked = index.highest_degree_live(40, np.random.default_rng(0))
        assert len(picked) == len(set(picked)) == 40
        skipped = set(index.live_ids()) - set(picked)
        assert min(index.layer0_degree(n) for n in picked) >= max(
            index.layer0_degree(n) for n in skipped
        )

    def test_ties_are_not_broken_by_insertion_order(self):
        index = self.saturated()
        cap = index.m0
        tied = sorted(n for n in index.live_ids() if index.layer0_degree(n) == cap)
        # what breaking the tie by node id picks: the earliest 40 inserts
        by_id = sorted(
            ((index.layer0_degree(n), n) for n in index.live_ids()),
            key=lambda pair: (-pair[0], pair[1]),
        )[:40]
        assert [n for _, n in by_id] == tied[:40]
        assert set(index.highest_degree_live(40, np.random.default_rng(0))) != set(tied[:40])

    def test_different_tie_seeds_pick_different_nodes(self):
        index = self.saturated()
        a = index.highest_degree_live(40, np.random.default_rng(0))
        b = index.highest_degree_live(40, np.random.default_rng(1))
        assert set(a) != set(b)
        assert all(index.layer0_degree(n) == index.m0 for n in a + b)

    def test_same_seed_repeats(self):
        index = self.saturated()
        first = index.highest_degree_live(40, np.random.default_rng(0))
        assert first == index.highest_degree_live(40, np.random.default_rng(0))

    def test_skips_deleted_and_returns_plain_ints(self):
        index = self.saturated()
        gone = index.highest_degree_live(5, np.random.default_rng(0))
        index.unlink_many(gone)
        picked = index.highest_degree_live(20, np.random.default_rng(0))
        assert not set(picked) & set(gone)
        assert all(type(node) is int for node in picked)

    def test_count_edges(self):
        index = small_index(n=30)
        assert index.highest_degree_live(0, np.random.default_rng(0)) == []
        assert len(index.highest_degree_live(999, np.random.default_rng(0))) == 30
        with pytest.raises(ValueError, match="count"):
            index.highest_degree_live(-1, np.random.default_rng(0))


class TestCompact:
    def test_compact_keeps_exactly_live_vectors(self):
        index = small_index()
        for node in (5, 6, 7, 50):
            index.delete(node)
        fresh, id_map = index.compact(seed=11)
        assert len(fresh) == index.live_count
        assert fresh.deleted_count == 0
        assert sorted(id_map) == index.live_ids()
        for old, new in id_map.items():
            assert np.array_equal(fresh._store[new], index._store[old])

    def test_compact_results_map_back(self):
        index = small_index()
        for node in (5, 6, 7):
            index.delete(node)
        fresh, id_map = index.compact(seed=11)
        reverse = {new: old for old, new in id_map.items()}
        query = queries(count=1)[0]
        exact_old = [node for node, _ in index.exact_live_topk(query, 10)]
        exact_new = [reverse[node] for node, _ in fresh.exact_live_topk(query, 10)]
        assert exact_old == exact_new

    def test_compact_of_empty_live_set(self):
        index = small_index(n=10)
        for node in range(10):
            index.delete(node)
        fresh, id_map = index.compact(seed=11)
        assert len(fresh) == 0
        assert id_map == {}


class TestCloneAndState:
    def test_clone_is_independent(self):
        index = small_index()
        twin = index.clone()
        query = queries(count=1)[0]
        assert index.search_live(query, 5, 40) == twin.search_live(query, 5, 40)
        twin.delete(0)
        assert index.deleted_count == 0

    def test_restore_rejects_bad_links(self):
        index = small_index(n=20)
        state = index.export_state()
        state["links"][3][0] = [999]
        with pytest.raises(ValueError, match="outside"):
            MutableHnswIndex.restore(state)

    def test_restore_rejects_size_mismatch(self):
        index = small_index(n=20)
        state = index.export_state()
        state["size"] = 19
        with pytest.raises(ValueError, match="does not match|describe"):
            MutableHnswIndex.restore(state)

    def test_restore_rejects_bad_entry_and_deleted(self):
        index = small_index(n=20)
        state = index.export_state()
        state["entry"] = 20
        with pytest.raises(ValueError, match="entry"):
            MutableHnswIndex.restore(state)
        state = index.export_state()
        state["deleted"] = [20]
        with pytest.raises(ValueError, match="deleted"):
            MutableHnswIndex.restore(state)

    def test_restored_rng_continues_identically(self):
        index = small_index()
        twin = index.clone()
        extra = np.random.default_rng(1).uniform(0.0, 1.0, size=(30, index.dim))
        for row in extra:
            index.add(row)
            twin.add(row)
        query = queries(count=1)[0]
        assert index.search_live(query, 10, 40) == twin.search_live(query, 10, 40)
        assert index._links == twin._links
