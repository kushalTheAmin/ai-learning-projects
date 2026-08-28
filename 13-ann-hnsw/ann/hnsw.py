"""HNSW (hierarchical navigable small world) from scratch.

The structure from Malkov & Yashunin (2016): every vector gets a random
level drawn from a geometric-ish distribution (floor(-ln(u) / ln(M))), a
node exists on every layer up to its level, and each layer is a greedy
proximity graph. Search starts at the single entry point on the top layer,
greedily descends one closest step per layer, then runs a best-first beam
of width ef on layer 0.

Two neighbor-selection modes, because the difference is the point of the
ablation in main.py:

- naive: link the M closest candidates.
- heuristic (the paper's algorithm 4): walk candidates nearest-first and
  keep one only if it is closer to the new node than to every neighbor
  already kept, then fill any spare slots from the discarded pile. This
  spends extra distance computations at build time to preserve long-range
  links between clusters that the M-closest rule would crowd out.

Distances are squared euclidean throughout, computed in batches per visited
node; every base-vector comparison increments distance_count.
"""

import heapq
from math import log

import numpy as np


class HnswIndex:
    def __init__(
        self,
        dim: int,
        m: int = 16,
        ef_construction: int = 100,
        seed: int = 0,
        heuristic: bool = True,
    ) -> None:
        if dim < 1:
            raise ValueError(f"dim must be >= 1, got {dim}")
        if m < 2:
            raise ValueError(f"m must be >= 2, got {m}")
        if ef_construction < 1:
            raise ValueError(f"ef_construction must be >= 1, got {ef_construction}")
        self.dim = dim
        self.m = m
        self.m0 = 2 * m  # degree cap on layer 0
        self.ef_construction = ef_construction
        self.heuristic = heuristic
        self._level_mult = 1.0 / log(m)
        self._rng = np.random.default_rng(seed)

        self._store = np.empty((0, dim), dtype=np.float64)
        self._size = 0
        # _links[node][layer] -> list of neighbor ids
        self._links: list[list[list[int]]] = []
        self._entry: int | None = None
        self._max_level = -1
        self.distance_count = 0

    def __len__(self) -> int:
        return self._size

    # -- storage ------------------------------------------------------------

    def _check(self, vector: np.ndarray) -> np.ndarray:
        vector = np.asarray(vector, dtype=np.float64)
        if vector.shape != (self.dim,):
            raise ValueError(f"vector must have shape ({self.dim},), got {vector.shape}")
        if not np.all(np.isfinite(vector)):
            raise ValueError("vector contains nan or inf")
        return vector

    def _append(self, vector: np.ndarray) -> int:
        if self._size == self._store.shape[0]:
            grown = np.empty((max(8, 2 * self._store.shape[0]), self.dim))
            grown[: self._size] = self._store[: self._size]
            self._store = grown
        self._store[self._size] = vector
        self._size += 1
        return self._size - 1

    def _dists(self, query: np.ndarray, ids: list[int]) -> np.ndarray:
        """Squared distances from query to each stored id, one batch."""
        diffs = self._store[ids] - query
        self.distance_count += len(ids)
        return np.einsum("ij,ij->i", diffs, diffs)

    # -- graph construction -------------------------------------------------

    def _draw_level(self) -> int:
        u = 1.0 - self._rng.random()  # (0, 1], keeps log finite
        return int(-log(u) * self._level_mult)

    def _search_layer(
        self, query: np.ndarray, entry_ids: list[int], ef: int, layer: int
    ) -> list[tuple[float, int]]:
        """Best-first beam search on one layer. Returns up to ef nodes as
        (squared distance, id), nearest first, ties broken by id."""
        visited = set(entry_ids)
        entry_dists = self._dists(query, entry_ids)
        candidates: list[tuple[float, int]] = []  # min-heap by (dist, id)
        results: list[tuple[float, int]] = []  # max-heap via negated dist
        for dist, node in zip(entry_dists, entry_ids):
            heapq.heappush(candidates, (float(dist), node))
            heapq.heappush(results, (-float(dist), node))
        while len(results) > ef:
            heapq.heappop(results)

        while candidates:
            dist, node = heapq.heappop(candidates)
            if len(results) == ef and dist > -results[0][0]:
                break
            fresh = [n for n in self._links[node][layer] if n not in visited]
            if not fresh:
                continue
            visited.update(fresh)
            for n_dist, neighbor in zip(self._dists(query, fresh), fresh):
                n_dist = float(n_dist)
                if len(results) < ef or n_dist < -results[0][0]:
                    heapq.heappush(candidates, (n_dist, neighbor))
                    heapq.heappush(results, (-n_dist, neighbor))
                    if len(results) > ef:
                        heapq.heappop(results)
        return sorted((-neg, node) for neg, node in results)

    def _select_neighbors(
        self, node_vec: np.ndarray, candidates: list[tuple[float, int]], count: int
    ) -> list[int]:
        """Pick up to count neighbors from (dist, id) candidates sorted
        nearest-first."""
        if not self.heuristic:
            return [node for _, node in candidates[:count]]
        kept: list[int] = []
        discarded: list[int] = []
        for dist, cand in candidates:
            if len(kept) == count:
                break
            if kept and bool(np.any(self._dists(self._store[cand], kept) < dist)):
                # cand sits closer to an already-kept neighbor than to the
                # node itself: linking it would duplicate a direction
                discarded.append(cand)
                continue
            kept.append(cand)
        for cand in discarded:
            if len(kept) == count:
                break
            kept.append(cand)
        return kept

    def _shrink(self, node: int, layer: int) -> None:
        cap = self.m0 if layer == 0 else self.m
        links = self._links[node][layer]
        if len(links) <= cap:
            return
        node_vec = self._store[node]
        ranked = sorted(zip(self._dists(node_vec, links), links), key=lambda p: (p[0], p[1]))
        self._links[node][layer] = self._select_neighbors(node_vec, ranked, cap)

    def add(self, vector: np.ndarray) -> int:
        vector = self._check(vector)
        level = self._draw_level()
        node = self._append(vector)
        self._links.append([[] for _ in range(level + 1)])

        if self._entry is None:
            self._entry = node
            self._max_level = level
            return node

        entry_points = [self._entry]
        for layer in range(self._max_level, level, -1):
            entry_points = [self._search_layer(vector, entry_points, 1, layer)[0][1]]

        for layer in range(min(level, self._max_level), -1, -1):
            candidates = self._search_layer(
                vector, entry_points, self.ef_construction, layer
            )
            selected = self._select_neighbors(vector, candidates, self.m)
            self._links[node][layer] = list(selected)
            for neighbor in selected:
                self._links[neighbor][layer].append(node)
                self._shrink(neighbor, layer)
            entry_points = [cand for _, cand in candidates]

        if level > self._max_level:
            self._entry = node
            self._max_level = level
        return node

    # -- queries ------------------------------------------------------------

    def search(self, query: np.ndarray, k: int, ef: int) -> list[tuple[int, float]]:
        """Top-k (id, squared distance), nearest first, ties broken by id.
        ef is the layer-0 beam width; values below k are raised to k."""
        if k < 1:
            raise ValueError(f"k must be >= 1, got {k}")
        if ef < 1:
            raise ValueError(f"ef must be >= 1, got {ef}")
        query = self._check(query)
        if self._entry is None:
            return []
        ef = max(ef, k)
        entry_points = [self._entry]
        for layer in range(self._max_level, 0, -1):
            entry_points = [self._search_layer(query, entry_points, 1, layer)[0][1]]
        found = self._search_layer(query, entry_points, ef, 0)
        return [(node, dist) for dist, node in found[:k]]

    # -- introspection ------------------------------------------------------

    def level_counts(self) -> list[int]:
        """Number of nodes whose top level is exactly each level, index 0 up."""
        counts = [0] * (self._max_level + 1)
        for links in self._links:
            counts[len(links) - 1] += 1
        return counts

    def degrees(self, layer: int) -> list[int]:
        """Out-degree of every node present on the given layer."""
        return [len(links[layer]) for links in self._links if layer < len(links)]

    def neighbors(self, node: int, layer: int) -> list[int]:
        return list(self._links[node][layer])

    def reachable_on_layer0(self) -> int:
        """Nodes reachable from node 0 following layer-0 links. Anything
        short of len(self) means part of the graph is invisible to search."""
        if self._size == 0:
            return 0
        seen = {0}
        frontier = [0]
        while frontier:
            node = frontier.pop()
            for neighbor in self._links[node][0]:
                if neighbor not in seen:
                    seen.add(neighbor)
                    frontier.append(neighbor)
        return len(seen)
