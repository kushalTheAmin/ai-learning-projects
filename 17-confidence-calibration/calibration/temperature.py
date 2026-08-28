"""Temperature scaling: divide logits by one scalar T fitted to
minimize validation NLL, then use the softened (or sharpened)
probabilities everywhere downstream.

The search works in inverse temperature s = 1/T. Cross-entropy is
convex in the logits and logits*s is linear in s, so NLL(s) is convex
in s and golden-section search on a bracket finds the global minimum
deterministically, no gradients and no luck involved. Because scaling
logits by a positive scalar never reorders a row, temperature scaling
can change every confidence and no prediction."""

import numpy as np

from calibration.metrics import nll

_GOLDEN = (np.sqrt(5.0) - 1.0) / 2.0


def nll_at_temperature(
    logits: np.ndarray, labels: np.ndarray, temperature: float
) -> float:
    if temperature <= 0.0:
        raise ValueError("temperature must be positive")
    return nll(logits / temperature, labels)


def fit_temperature(
    logits: np.ndarray,
    labels: np.ndarray,
    lo: float = 0.02,
    hi: float = 50.0,
    iterations: int = 90,
) -> float:
    """Golden-section search over inverse temperature in [1/hi, 1/lo].
    90 iterations shrink the bracket below 1e-15 of its width, far past
    float64 resolution."""
    if logits.shape[0] == 0:
        raise ValueError("cannot fit a temperature on zero rows")
    if not 0.0 < lo < hi:
        raise ValueError("need 0 < lo < hi")

    def objective(s: float) -> float:
        return nll_at_temperature(logits, labels, 1.0 / s)

    a, b = 1.0 / hi, 1.0 / lo
    c = b - _GOLDEN * (b - a)
    d = a + _GOLDEN * (b - a)
    fc, fd = objective(c), objective(d)
    for _ in range(iterations):
        if fc < fd:
            b, d, fd = d, c, fc
            c = b - _GOLDEN * (b - a)
            fc = objective(c)
        else:
            a, c, fc = c, d, fd
            d = a + _GOLDEN * (b - a)
            fd = objective(d)
    return 1.0 / ((a + b) / 2.0)
