"""Cheap trust signals and the machinery to compare them fairly.

Max softmax is one way to read "how sure is the model" off a probability
row; margin (top1 minus top2) and negative entropy are two others, free
from the same row. Thresholds on different signals live on different
scales, so the fair comparison is ordering: sort predictions from most
to least trusted and watch the error rate grow as coverage grows. That
is the risk-coverage curve, and its mean over all coverages (AURC) is a
single number for how well a signal ranks mistakes last. Every signal
here is oriented so that higher means more trusted.
"""

from dataclasses import dataclass

import numpy as np


def _check_rows(rows: np.ndarray, min_columns: int = 2) -> None:
    if rows.ndim != 2:
        raise ValueError("expected a 2-d array of rows")
    if rows.shape[0] == 0:
        raise ValueError("expected at least one row")
    if rows.shape[1] < min_columns:
        raise ValueError(f"expected at least {min_columns} columns")


def max_softmax(probs: np.ndarray) -> np.ndarray:
    """The probability of the top prediction, per row."""
    _check_rows(probs)
    return probs.max(axis=1)


def _top_two_gap(rows: np.ndarray) -> np.ndarray:
    _check_rows(rows)
    part = np.partition(rows, rows.shape[1] - 2, axis=1)
    return part[:, -1] - part[:, -2]


def margin(probs: np.ndarray) -> np.ndarray:
    """Top probability minus runner-up probability, per row. 0 when the
    top two classes are tied, 1 when all mass sits on one class."""
    return _top_two_gap(probs)


def negative_entropy(probs: np.ndarray) -> np.ndarray:
    """Minus the Shannon entropy of the row, in nats, with 0 log 0 = 0.
    A one-hot row scores 0 (maximal trust), a uniform row -log K."""
    _check_rows(probs)
    terms = np.where(probs > 0.0, probs * np.log(np.where(probs > 0.0, probs, 1.0)), 0.0)
    return terms.sum(axis=1)


def logit_margin(logits: np.ndarray) -> np.ndarray:
    """Top logit minus runner-up logit, per row. Dividing every logit by
    a positive temperature scales this uniformly, so the ordering it
    induces over examples is temperature-invariant by construction."""
    return _top_two_gap(logits)


@dataclass(frozen=True)
class RiskCoverageCurve:
    coverage: np.ndarray  # fraction answered after each step, ascending
    risk: np.ndarray  # error rate among the answered prefix at each step


def _trust_order(signal: np.ndarray, n: int) -> np.ndarray:
    """Indices from most to least trusted; ties broken by input index so
    the ordering is deterministic."""
    return np.lexsort((np.arange(n), -signal))


def risk_coverage(signal: np.ndarray, correct: np.ndarray) -> RiskCoverageCurve:
    """Answer the most-trusted k items for every k and report the error
    rate of each prefix."""
    if signal.ndim != 1 or correct.ndim != 1:
        raise ValueError("signal and correct must be 1-d")
    if signal.shape[0] != correct.shape[0]:
        raise ValueError("signal and correct disagree on length")
    n = signal.shape[0]
    if n == 0:
        raise ValueError("expected at least one item")
    order = _trust_order(signal, n)
    errors = np.cumsum(~correct[order].astype(bool))
    k = np.arange(1, n + 1, dtype=np.float64)
    return RiskCoverageCurve(coverage=k / n, risk=errors / k)


def aurc(signal: np.ndarray, correct: np.ndarray) -> float:
    """Area under the risk-coverage curve: the mean prefix error rate
    over all coverages. Lower is better; 0 means every mistake is ranked
    after every correct answer."""
    return float(risk_coverage(signal, correct).risk.mean())


def oracle_aurc(correct: np.ndarray) -> float:
    """AURC of the best possible ordering (all correct items first).
    The floor any signal is judged against at this accuracy."""
    if correct.ndim != 1 or correct.shape[0] == 0:
        raise ValueError("expected a non-empty 1-d correctness array")
    n = correct.shape[0]
    n_correct = int(correct.astype(bool).sum())
    k = np.arange(1, n + 1, dtype=np.float64)
    errors = np.maximum(0.0, k - n_correct)
    return float((errors / k).mean())


@dataclass(frozen=True)
class OperatingPoint:
    answered: int
    total: int
    risk: float

    @property
    def coverage(self) -> float:
        return self.answered / self.total


def coverage_at_risk(
    signal: np.ndarray, correct: np.ndarray, max_risk: float
) -> OperatingPoint | None:
    """The widest most-trusted prefix whose error rate stays within
    max_risk, or None when even the single most-trusted item misses it."""
    curve = risk_coverage(signal, correct)
    within = np.nonzero(curve.risk <= max_risk)[0]
    if within.size == 0:
        return None
    answered = int(within[-1]) + 1
    return OperatingPoint(
        answered=answered,
        total=signal.shape[0],
        risk=float(curve.risk[answered - 1]),
    )


def risk_at_coverage(
    signal: np.ndarray, correct: np.ndarray, target_coverage: float
) -> float:
    """Error rate of the most-trusted prefix covering at least
    target_coverage of the items."""
    if not 0.0 < target_coverage <= 1.0:
        raise ValueError("target_coverage must be in (0, 1]")
    curve = risk_coverage(signal, correct)
    n = signal.shape[0]
    answered = int(np.ceil(target_coverage * n))
    return float(curve.risk[answered - 1])


def pair_disagreement(a: np.ndarray, b: np.ndarray) -> float:
    """Fraction of item pairs the two signals order in strictly opposite
    directions. Pairs tied under either signal do not count as
    disagreement. 0 means the orderings never conflict, 1 means they are
    exact reverses."""
    if a.ndim != 1 or b.ndim != 1 or a.shape[0] != b.shape[0]:
        raise ValueError("expected two 1-d arrays of equal length")
    n = a.shape[0]
    if n < 2:
        raise ValueError("expected at least two items")
    direction_a = np.sign(a[:, None] - a[None, :])
    direction_b = np.sign(b[:, None] - b[None, :])
    conflicts = int(((direction_a * direction_b) < 0).sum()) // 2
    return conflicts / (n * (n - 1) / 2)
