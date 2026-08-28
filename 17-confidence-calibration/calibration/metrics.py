"""Probability, calibration and selective-answering metrics.

Confidence throughout means the probability the model assigns to its own
top prediction (max of the softmax row). Calibration asks whether that
number means what it says: among predictions made at confidence c, is
the model right a fraction c of the time?
"""

from dataclasses import dataclass

import numpy as np


def softmax(logits: np.ndarray) -> np.ndarray:
    """Row-wise softmax, shifted by the row max so large logits do not
    overflow."""
    shifted = logits - logits.max(axis=1, keepdims=True)
    exp = np.exp(shifted)
    return exp / exp.sum(axis=1, keepdims=True)


def log_softmax(logits: np.ndarray) -> np.ndarray:
    shifted = logits - logits.max(axis=1, keepdims=True)
    return shifted - np.log(np.exp(shifted).sum(axis=1, keepdims=True))


def _check_pairing(rows: np.ndarray, labels: np.ndarray) -> None:
    if rows.ndim != 2:
        raise ValueError("expected a 2-d array of rows")
    if rows.shape[0] == 0:
        raise ValueError("expected at least one row")
    if rows.shape[0] != labels.shape[0]:
        raise ValueError("rows and labels disagree on length")


def nll(logits: np.ndarray, labels: np.ndarray) -> float:
    """Mean negative log-likelihood of the true labels."""
    _check_pairing(logits, labels)
    logp = log_softmax(logits)
    return float(-logp[np.arange(labels.shape[0]), labels].mean())


def predictions(probs: np.ndarray) -> np.ndarray:
    return probs.argmax(axis=1)


def confidence(probs: np.ndarray) -> np.ndarray:
    return probs.max(axis=1)


def accuracy(probs: np.ndarray, labels: np.ndarray) -> float:
    _check_pairing(probs, labels)
    return float((predictions(probs) == labels).mean())


def brier(probs: np.ndarray, labels: np.ndarray) -> float:
    """Multiclass Brier score: mean squared distance between the
    probability row and the one-hot label. 0 is perfect, 2 is worst."""
    _check_pairing(probs, labels)
    onehot = np.zeros_like(probs)
    onehot[np.arange(labels.shape[0]), labels] = 1.0
    return float(((probs - onehot) ** 2).sum(axis=1).mean())


@dataclass(frozen=True)
class BinRow:
    lo: float
    hi: float
    count: int
    mean_confidence: float
    accuracy: float

    @property
    def gap(self) -> float:
        return self.mean_confidence - self.accuracy


def reliability_table(
    probs: np.ndarray, labels: np.ndarray, n_bins: int = 10
) -> list[BinRow]:
    """Equal-width confidence bins; a confidence of exactly 1.0 lands in
    the last bin. Empty bins are omitted."""
    _check_pairing(probs, labels)
    if n_bins < 1:
        raise ValueError("n_bins must be >= 1")
    conf = confidence(probs)
    correct = predictions(probs) == labels
    bin_index = np.minimum((conf * n_bins).astype(np.int64), n_bins - 1)
    rows: list[BinRow] = []
    for b in range(n_bins):
        mask = bin_index == b
        count = int(mask.sum())
        if count == 0:
            continue
        rows.append(
            BinRow(
                lo=b / n_bins,
                hi=(b + 1) / n_bins,
                count=count,
                mean_confidence=float(conf[mask].mean()),
                accuracy=float(correct[mask].mean()),
            )
        )
    return rows


def ece(probs: np.ndarray, labels: np.ndarray, n_bins: int = 10) -> float:
    """Expected calibration error: count-weighted mean |confidence -
    accuracy| over the reliability bins."""
    rows = reliability_table(probs, labels, n_bins)
    total = probs.shape[0]
    return float(sum(abs(r.gap) * r.count / total for r in rows))


def mce(probs: np.ndarray, labels: np.ndarray, n_bins: int = 10) -> float:
    """Maximum calibration error: the worst bin's |confidence - accuracy|."""
    rows = reliability_table(probs, labels, n_bins)
    return float(max(abs(r.gap) for r in rows))


@dataclass(frozen=True)
class SelectiveRow:
    threshold: float
    answered: int
    total: int
    accuracy_answered: float | None  # None when nothing clears the bar

    @property
    def coverage(self) -> float:
        return self.answered / self.total


def selective(
    probs: np.ndarray, labels: np.ndarray, threshold: float
) -> SelectiveRow:
    """Auto-answer policy: answer iff confidence >= threshold, escalate
    the rest. Reports how much gets answered and how accurate it is."""
    _check_pairing(probs, labels)
    conf = confidence(probs)
    mask = conf >= threshold
    answered = int(mask.sum())
    acc = (
        float((predictions(probs)[mask] == labels[mask]).mean())
        if answered
        else None
    )
    return SelectiveRow(
        threshold=threshold,
        answered=answered,
        total=probs.shape[0],
        accuracy_answered=acc,
    )
