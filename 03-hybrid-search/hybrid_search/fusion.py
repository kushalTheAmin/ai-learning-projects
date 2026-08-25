"""Combine rankings/scores from multiple retrievers into one ranking."""

import numpy as np


def reciprocal_rank_fusion(rankings: list[np.ndarray], k: int = 60) -> np.ndarray:
    """Fuse rankings by summing 1 / (k + rank) per document.

    RRF only looks at rank positions, so it needs no score normalization
    and is robust to the two retrievers having incomparable score scales.
    k=60 is the constant from the original Cormack et al. paper; larger k
    flattens the difference between top positions.
    """
    if not rankings:
        raise ValueError("need at least one ranking to fuse")
    n_docs = len(rankings[0])
    if any(len(r) != n_docs for r in rankings):
        raise ValueError("all rankings must cover the same document set")
    fused = np.zeros(n_docs)
    for ranking in rankings:
        positions = np.empty(n_docs)
        positions[ranking] = np.arange(n_docs)
        fused += 1.0 / (k + positions + 1.0)
    return np.argsort(-fused, kind="stable")


def weighted_score_fusion(
    bm25_scores: np.ndarray, dense_scores: np.ndarray, alpha: float
) -> np.ndarray:
    """Blend min-max-normalized scores: alpha * dense + (1 - alpha) * bm25.

    alpha=0 is pure BM25, alpha=1 is pure dense. Unlike RRF this keeps
    score magnitudes, so a confident exact match can outweigh many weak
    semantic matches — but it requires normalization to compare scales.
    """
    if not 0.0 <= alpha <= 1.0:
        raise ValueError(f"alpha must be in [0, 1], got {alpha}")
    if bm25_scores.shape != dense_scores.shape:
        raise ValueError("score arrays must have the same shape")
    blended = alpha * _min_max(dense_scores) + (1.0 - alpha) * _min_max(bm25_scores)
    return np.argsort(-blended, kind="stable")


def _min_max(scores: np.ndarray) -> np.ndarray:
    span = scores.max() - scores.min()
    if span == 0.0:
        return np.zeros_like(scores)
    return (scores - scores.min()) / span
