"""Precision/recall bookkeeping over predicted vs true duplicate pairs."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class PairScores:
    precision: float
    recall: float
    f1: float
    predicted: int
    true_positives: int


def score_pairs(
    predicted: set[tuple[str, str]], truth: set[tuple[str, str]]
) -> PairScores:
    if not truth:
        raise ValueError("truth set is empty; nothing to score against")
    tp = len(predicted & truth)
    precision = tp / len(predicted) if predicted else 0.0
    recall = tp / len(truth)
    f1 = (
        2 * precision * recall / (precision + recall)
        if precision + recall > 0
        else 0.0
    )
    return PairScores(precision, recall, f1, len(predicted), tp)


def mean_absolute_error(pairs: list[tuple[float, float]]) -> float:
    if not pairs:
        raise ValueError("no (estimate, exact) pairs to average")
    return sum(abs(est - exact) for est, exact in pairs) / len(pairs)


def max_absolute_error(pairs: list[tuple[float, float]]) -> float:
    if not pairs:
        raise ValueError("no (estimate, exact) pairs to compare")
    return max(abs(est - exact) for est, exact in pairs)
