"""Exact brute-force nearest neighbor: the ground truth and the cost baseline.

Distances are squared euclidean. Squared L2 orders candidates identically to
L2, so no square root is ever needed for ranking. The distance counter counts
base vectors compared against, one per stored vector per query, even though
the arithmetic runs as one vectorized numpy pass.
"""

import numpy as np


def _check_query(query: np.ndarray, dim: int) -> np.ndarray:
    query = np.asarray(query, dtype=np.float64)
    if query.shape != (dim,):
        raise ValueError(f"query must have shape ({dim},), got {query.shape}")
    if not np.all(np.isfinite(query)):
        raise ValueError("query contains nan or inf")
    return query


class ExactIndex:
    """Flat index: stores vectors, scans all of them per query."""

    def __init__(self, dim: int) -> None:
        if dim < 1:
            raise ValueError(f"dim must be >= 1, got {dim}")
        self.dim = dim
        self._rows: list[np.ndarray] = []
        self._matrix: np.ndarray | None = None
        self.distance_count = 0

    def __len__(self) -> int:
        return len(self._rows)

    def add(self, vector: np.ndarray) -> int:
        vector = _check_query(vector, self.dim)
        self._rows.append(vector)
        self._matrix = None
        return len(self._rows) - 1

    def _vectors(self) -> np.ndarray:
        if self._matrix is None:
            self._matrix = np.vstack(self._rows)
        return self._matrix

    def search(self, query: np.ndarray, k: int) -> list[tuple[int, float]]:
        """Top-k (id, squared distance), nearest first, ties broken by id."""
        if k < 1:
            raise ValueError(f"k must be >= 1, got {k}")
        query = _check_query(query, self.dim)
        if not self._rows:
            return []
        diffs = self._vectors() - query
        dists = np.einsum("ij,ij->i", diffs, diffs)
        self.distance_count += len(self._rows)
        k = min(k, len(self._rows))
        # lexsort on (id, dist): stable nearest-first with id as the tiebreak
        order = np.lexsort((np.arange(len(dists)), dists))[:k]
        return [(int(i), float(dists[i])) for i in order]
