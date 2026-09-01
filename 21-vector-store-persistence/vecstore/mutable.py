"""HNSW index with deletes and a serializable state.

Two delete modes, because they are different operations with different
costs and the difference is what main.py measures:

- delete (tombstone): the node stays in the graph and keeps routing
  traffic; it is only filtered out of results. Recall survives, but every
  query pays distance computations on dead nodes and results can come up
  short of k when the beam fills with tombstones.
- unlink (hard removal): the node's edges are removed from the whole
  graph. Queries stop paying for it, but the graph loses whatever
  connectivity those edges provided, and nothing repairs the hole.

compact() is the third option: rebuild a fresh index from the live
vectors, paying full build cost to get a clean graph back.

export_state()/restore() give persistence (and cloning) a single, complete
description of an index: parameters, vectors, links, entry point,
tombstones, distance counter, and the RNG state. The RNG state matters
because level draws consume it: an index restored without it would grow a
different graph than the original from the same future inserts.
"""

from typing import Any, Iterable

import numpy as np

from .reuse import HnswIndex


class MutableHnswIndex(HnswIndex):
    def __init__(
        self,
        dim: int,
        m: int = 16,
        ef_construction: int = 100,
        seed: int = 0,
        heuristic: bool = True,
    ) -> None:
        super().__init__(
            dim=dim, m=m, ef_construction=ef_construction, seed=seed, heuristic=heuristic
        )
        self._deleted: set[int] = set()

    # -- liveness -----------------------------------------------------------

    @property
    def deleted_count(self) -> int:
        return len(self._deleted)

    @property
    def live_count(self) -> int:
        return len(self) - len(self._deleted)

    def is_deleted(self, node: int) -> bool:
        self._check_id(node)
        return node in self._deleted

    def live_ids(self) -> list[int]:
        return [i for i in range(len(self)) if i not in self._deleted]

    def _check_id(self, node: int) -> None:
        if not isinstance(node, (int, np.integer)) or isinstance(node, bool):
            raise ValueError(f"node id must be an int, got {node!r}")
        if node < 0 or node >= len(self):
            raise ValueError(f"node id {node} out of range for index of size {len(self)}")

    # -- deletes ------------------------------------------------------------

    def delete(self, node: int) -> None:
        """Tombstone: keep the node routing, drop it from results."""
        self._check_id(node)
        if node in self._deleted:
            raise ValueError(f"node {node} is already deleted")
        self._deleted.add(node)

    def unlink(self, node: int) -> None:
        self.unlink_many([node])

    def unlink_many(self, nodes: Iterable[int]) -> None:
        """Hard removal: delete the nodes and strip their edges everywhere.

        One pass over the whole graph serves the entire batch; edges are not
        guaranteed symmetric (degree-cap shrinking drops them one-sided), so
        in-edges can only be found by scanning.
        """
        doomed: set[int] = set()
        for node in nodes:
            self._check_id(node)
            if node in self._deleted:
                raise ValueError(f"node {node} is already deleted")
            if node in doomed:
                raise ValueError(f"node {node} appears twice in one unlink batch")
            doomed.add(node)
        if not doomed:
            return
        self._deleted |= doomed
        for node in doomed:
            self._links[node] = [[] for _ in self._links[node]]
        for other in range(len(self)):
            if other in doomed:
                continue
            layers = self._links[other]
            for layer, ids in enumerate(layers):
                if any(x in doomed for x in ids):
                    layers[layer] = [x for x in ids if x not in doomed]
        if self._entry in doomed:
            self._reset_entry()

    def _reset_entry(self) -> None:
        """Point the entry at the highest-level live node, lowest id on ties."""
        best, best_level = None, -1
        for node in range(len(self)):
            if node in self._deleted:
                continue
            level = len(self._links[node]) - 1
            if level > best_level:
                best, best_level = node, level
        self._entry = best
        self._max_level = best_level

    # -- queries over the live set ------------------------------------------

    def search_live(self, query: np.ndarray, k: int, ef: int) -> list[tuple[int, float]]:
        """Top-k live (id, squared distance): fetch an ef-wide result set,
        filter tombstones, keep the nearest k. Can return fewer than k when
        the beam fills with dead nodes; the caller sees the shortfall."""
        if k < 1:
            raise ValueError(f"k must be >= 1, got {k}")
        if ef < 1:
            raise ValueError(f"ef must be >= 1, got {ef}")
        fetch = max(ef, k)
        results = self.search(query, fetch, fetch)
        live = [(node, dist) for node, dist in results if node not in self._deleted]
        return live[:k]

    def exact_live_topk(self, query: np.ndarray, k: int) -> list[tuple[int, float]]:
        """Ground truth: brute-force top-k over live vectors, (distance, id)
        ordering. Does not touch distance_count; it is the measuring stick,
        not part of the graph's cost."""
        if k < 1:
            raise ValueError(f"k must be >= 1, got {k}")
        query = self._check(query)
        live = self.live_ids()
        if not live:
            return []
        ids = np.array(live)
        diffs = self._store[ids] - query
        dists = np.einsum("ij,ij->i", diffs, diffs)
        order = np.lexsort((ids, dists))[: min(k, len(live))]
        return [(int(ids[i]), float(dists[i])) for i in order]

    # -- compaction ---------------------------------------------------------

    def compact(self, seed: int) -> tuple["MutableHnswIndex", dict[int, int]]:
        """Rebuild a fresh index from live vectors only, in id order.
        Returns (new index, old id -> new id map); the new index's
        distance_count is the build cost."""
        fresh = MutableHnswIndex(
            dim=self.dim,
            m=self.m,
            ef_construction=self.ef_construction,
            seed=seed,
            heuristic=self.heuristic,
        )
        id_map: dict[int, int] = {}
        for old in self.live_ids():
            id_map[old] = fresh.add(self._store[old])
        return fresh, id_map

    # -- graph introspection -------------------------------------------------

    def reachable_live_from_entry(self) -> int:
        """Live nodes reachable from the entry point following layer-0 links.
        Tombstoned nodes still conduct (their edges are intact); unlinked
        nodes do not. Short of live_count means search cannot see part of
        the live set."""
        if self._entry is None:
            return 0
        seen = {self._entry}
        frontier = [self._entry]
        while frontier:
            node = frontier.pop()
            for neighbor in self._links[node][0]:
                if neighbor not in seen:
                    seen.add(neighbor)
                    frontier.append(neighbor)
        return sum(1 for node in seen if node not in self._deleted)

    def layer0_degree(self, node: int) -> int:
        self._check_id(node)
        return len(self._links[node][0])

    def highest_degree_live(self, count: int, rng: np.random.Generator) -> list[int]:
        """The count most connected live nodes on layer 0, ties drawn from rng.

        The tie-break is the whole reason this takes an rng. Layer-0 degree
        is capped at m0 and a large share of a built graph sits exactly at
        the cap, so ranking by degree leaves hundreds of nodes level with
        each other. Breaking that tie by node id would return the lowest ids,
        which are the earliest inserts, and an insertion-order removal is a
        different attack with a different answer.
        """
        if count < 0:
            raise ValueError(f"count must be >= 0, got {count}")
        live = self.live_ids()
        draws = rng.permutation(len(live))
        ranked = sorted(
            zip((self.layer0_degree(node) for node in live), draws, live),
            key=lambda triple: (-triple[0], triple[1]),
        )
        return [node for _, _, node in ranked[:count]]

    def node_level(self, node: int) -> int:
        """Top layer this node exists on."""
        self._check_id(node)
        return len(self._links[node]) - 1

    # -- serializable state --------------------------------------------------

    def export_state(self) -> dict[str, Any]:
        return {
            "dim": self.dim,
            "m": self.m,
            "ef_construction": self.ef_construction,
            "heuristic": self.heuristic,
            "size": len(self),
            "entry": self._entry,
            "max_level": self._max_level,
            "deleted": sorted(self._deleted),
            "rng_state": self._rng.bit_generator.state,
            "distance_count": self.distance_count,
            "vectors": np.array(self._store[: len(self)], dtype=np.float64, copy=True),
            "links": [[list(ids) for ids in layers] for layers in self._links],
        }

    @classmethod
    def restore(cls, state: dict[str, Any]) -> "MutableHnswIndex":
        index = cls(
            dim=state["dim"],
            m=state["m"],
            ef_construction=state["ef_construction"],
            seed=0,
            heuristic=state["heuristic"],
        )
        size = state["size"]
        vectors = np.array(state["vectors"], dtype=np.float64, copy=True)
        links = state["links"]
        if vectors.shape != (size, state["dim"]):
            raise ValueError(
                f"vectors shape {vectors.shape} does not match "
                f"size {size} x dim {state['dim']}"
            )
        if not np.all(np.isfinite(vectors)):
            raise ValueError("vectors contain nan or inf")
        if len(links) != size:
            raise ValueError(f"links describe {len(links)} nodes, size says {size}")
        for node, layers in enumerate(links):
            if not layers:
                raise ValueError(f"node {node} has no layers")
            for ids in layers:
                for neighbor in ids:
                    if not 0 <= neighbor < size:
                        raise ValueError(
                            f"node {node} links to {neighbor}, outside [0, {size})"
                        )
        entry = state["entry"]
        if entry is not None and not 0 <= entry < size:
            raise ValueError(f"entry {entry} outside [0, {size})")
        deleted = set(state["deleted"])
        for node in deleted:
            if not 0 <= node < size:
                raise ValueError(f"deleted id {node} outside [0, {size})")
        index._store = vectors
        index._size = size
        index._links = [[list(ids) for ids in layers] for layers in links]
        index._entry = entry
        index._max_level = state["max_level"]
        index._rng = np.random.default_rng(0)
        index._rng.bit_generator.state = state["rng_state"]
        index._deleted = deleted
        index.distance_count = state["distance_count"]
        return index

    def clone(self) -> "MutableHnswIndex":
        return MutableHnswIndex.restore(self.export_state())
