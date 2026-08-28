"""Seeded synthetic vector datasets.

Clustered data is the interesting case for graph-based ANN: real embedding
spaces are lumpy, and the neighbor-selection heuristic in HNSW exists
precisely to keep long-range links between lumps alive. Uniform data is the
control where clustering effects vanish.
"""

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class Dataset:
    """Base vectors to index plus held-out query vectors from the same source."""

    vectors: np.ndarray  # shape (n, dim), float64
    queries: np.ndarray  # shape (q, dim), float64

    def __post_init__(self) -> None:
        if self.vectors.ndim != 2 or self.queries.ndim != 2:
            raise ValueError("vectors and queries must be 2-d arrays")
        if self.vectors.shape[1] != self.queries.shape[1]:
            raise ValueError(
                f"dimension mismatch: vectors are {self.vectors.shape[1]}-d, "
                f"queries are {self.queries.shape[1]}-d"
            )


def clustered_dataset(
    n_vectors: int,
    n_queries: int,
    dim: int,
    n_clusters: int,
    seed: int,
    cluster_std: float = 0.15,
    outlier_fraction: float = 0.05,
) -> Dataset:
    """Gaussian mixture: cluster centers uniform in the unit cube, points
    normal around a randomly chosen center. A small fraction of queries are
    uniform outliers that belong to no cluster."""
    if n_clusters < 1:
        raise ValueError(f"n_clusters must be >= 1, got {n_clusters}")
    rng = np.random.default_rng(seed)
    centers = rng.uniform(0.0, 1.0, size=(n_clusters, dim))

    def draw(count: int) -> np.ndarray:
        assignment = rng.integers(0, n_clusters, size=count)
        return centers[assignment] + rng.normal(0.0, cluster_std, size=(count, dim))

    vectors = draw(n_vectors)
    n_outliers = int(round(n_queries * outlier_fraction))
    queries = np.concatenate(
        [draw(n_queries - n_outliers), rng.uniform(0.0, 1.0, size=(n_outliers, dim))]
    )
    return Dataset(vectors=vectors, queries=queries)


def uniform_dataset(n_vectors: int, n_queries: int, dim: int, seed: int) -> Dataset:
    """Everything i.i.d. uniform in the unit cube: no cluster structure at all."""
    rng = np.random.default_rng(seed)
    return Dataset(
        vectors=rng.uniform(0.0, 1.0, size=(n_vectors, dim)),
        queries=rng.uniform(0.0, 1.0, size=(n_queries, dim)),
    )
