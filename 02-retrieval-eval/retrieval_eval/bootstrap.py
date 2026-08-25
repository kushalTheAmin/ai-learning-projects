"""Paired bootstrap resampling for retrieval metrics.

The golden set here is 38 queries, and a difference between two means over
38 numbers can easily be noise. The bootstrap answers how easily: resample
the query set with replacement many times, recompute the statistic on each
resample, and read the spread of the results as the uncertainty of the
measurement.

For comparing two systems the resampling must be paired — both systems are
scored on the same resampled queries. Concretely that means resampling the
per-query score differences, which preserves the coupling between systems
(both acing the easy queries, both missing the vocabulary-mismatch ones)
instead of averaging it away. Unpaired resampling would report the spread
of two independent evals, which is much wider and answers a different
question.
"""

import math
import random
from dataclasses import dataclass

from .metrics import mean


@dataclass(frozen=True)
class ConfidenceInterval:
    point: float  # statistic on the real, unresampled sample
    lo: float
    hi: float
    confidence: float


@dataclass(frozen=True)
class PairedComparison:
    diff: float  # mean(a) - mean(b) on the real sample
    ci: ConfidenceInterval  # bootstrap interval for that difference
    p_le_zero: float  # fraction of resamples where mean(a) - mean(b) <= 0


def percentile(sorted_values: list[float], q: float) -> float:
    """Linearly interpolated percentile of pre-sorted values, q in [0, 1]."""
    if not sorted_values:
        raise ValueError("cannot take a percentile of an empty list")
    if not 0.0 <= q <= 1.0:
        raise ValueError(f"q must be in [0, 1], got {q}")
    position = q * (len(sorted_values) - 1)
    below, above = math.floor(position), math.ceil(position)
    fraction = position - below
    return sorted_values[below] * (1 - fraction) + sorted_values[above] * fraction


def _resampled_means(
    values: list[float], n_resamples: int, rng: random.Random
) -> list[float]:
    n = len(values)
    return [
        mean([values[rng.randrange(n)] for _ in range(n)])
        for _ in range(n_resamples)
    ]


def _validate(values: list[float], n_resamples: int, confidence: float) -> None:
    if not values:
        raise ValueError("values must be non-empty")
    if n_resamples < 1:
        raise ValueError(f"n_resamples must be >= 1, got {n_resamples}")
    if not 0.0 < confidence < 1.0:
        raise ValueError(f"confidence must be in (0, 1), got {confidence}")


def bootstrap_ci(
    values: list[float],
    n_resamples: int = 10_000,
    confidence: float = 0.95,
    seed: int = 0,
) -> ConfidenceInterval:
    """Percentile bootstrap interval for the mean of `values`."""
    _validate(values, n_resamples, confidence)
    stats = sorted(_resampled_means(values, n_resamples, random.Random(seed)))
    alpha = (1.0 - confidence) / 2.0
    return ConfidenceInterval(
        point=mean(values),
        lo=percentile(stats, alpha),
        hi=percentile(stats, 1.0 - alpha),
        confidence=confidence,
    )


def paired_bootstrap(
    values_a: list[float],
    values_b: list[float],
    n_resamples: int = 10_000,
    confidence: float = 0.95,
    seed: int = 0,
) -> PairedComparison:
    """Bootstrap the mean difference between two paired samples.

    values_a[i] and values_b[i] must belong to the same query. p_le_zero is
    the fraction of resamples where the difference comes out <= 0 — how
    often "a beats b" fails to survive resampling. It is a direction check,
    not a hypothesis-test p-value.
    """
    if len(values_a) != len(values_b):
        raise ValueError(
            f"paired samples must have equal length, got {len(values_a)} and {len(values_b)}"
        )
    diffs = [a - b for a, b in zip(values_a, values_b)]
    _validate(diffs, n_resamples, confidence)
    stats = sorted(_resampled_means(diffs, n_resamples, random.Random(seed)))
    alpha = (1.0 - confidence) / 2.0
    ci = ConfidenceInterval(
        point=mean(diffs),
        lo=percentile(stats, alpha),
        hi=percentile(stats, 1.0 - alpha),
        confidence=confidence,
    )
    p_le_zero = sum(1 for s in stats if s <= 0.0) / len(stats)
    return PairedComparison(diff=ci.point, ci=ci, p_le_zero=p_le_zero)
