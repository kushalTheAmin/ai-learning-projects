"""Retrieve on quantized vectors, rerank the candidates on float vectors.

The standard production shape: codes live in RAM and answer every query,
full-precision rows live somewhere slower and are fetched only for the
short candidate list. The knob is the candidate count: how many float
fetches buy back how much of the recall that quantization lost.
"""

import numpy as np

from .reuse import ExactIndex


def float_rerank(
    float_vectors: np.ndarray,
    candidate_ids: list[int],
    query: np.ndarray,
    k: int,
) -> list[tuple[int, float]]:
    """Top-k (id, squared L2) among the candidates, nearest first, ties by id.

    Distances come from float_vectors, whatever index produced the
    candidates. Duplicate candidate ids collapse to one.
    """
    if k < 1:
        raise ValueError(f"k must be >= 1, got {k}")
    ids = sorted(set(candidate_ids))
    if not ids:
        return []
    query = np.asarray(query, dtype=np.float64)
    diffs = float_vectors[ids] - query
    dists = np.einsum("ij,ij->i", diffs, diffs)
    order = np.lexsort((ids, dists))[: min(k, len(ids))]
    return [(int(ids[i]), float(dists[i])) for i in order]


def search_with_rerank(
    quantized_index: ExactIndex,
    float_vectors: np.ndarray,
    query: np.ndarray,
    k: int,
    n_candidates: int,
) -> list[tuple[int, float]]:
    """Quantized top-n_candidates, then float rerank down to top-k."""
    if n_candidates < k:
        raise ValueError(
            f"n_candidates must be >= k, got {n_candidates} < {k}"
        )
    candidates = quantized_index.search(query, n_candidates)
    return float_rerank(float_vectors, [i for i, _ in candidates], query, k)
