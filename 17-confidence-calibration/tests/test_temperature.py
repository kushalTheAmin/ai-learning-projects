import numpy as np
import pytest

from calibration.metrics import nll, predictions, softmax
from calibration.temperature import fit_temperature, nll_at_temperature


def _calibrated_logits_scaled(scale: float, n: int = 6000, seed: int = 11):
    """Logits whose softmax is the true label distribution, then scaled
    by `scale`. The NLL-optimal temperature is `scale` in expectation."""
    rng = np.random.default_rng(seed)
    logits = rng.normal(size=(n, 4)) * 1.5
    probs = softmax(logits)
    labels = np.array(
        [rng.choice(4, p=row) for row in probs], dtype=np.int64
    )
    return logits * scale, labels


def test_recovers_a_known_overconfidence_factor():
    logits, labels = _calibrated_logits_scaled(2.0)
    fitted = fit_temperature(logits, labels)
    assert 1.8 < fitted < 2.2


def test_recovers_a_known_underconfidence_factor():
    logits, labels = _calibrated_logits_scaled(0.5)
    fitted = fit_temperature(logits, labels)
    assert 0.45 < fitted < 0.56


def test_calibrated_logits_fit_near_one():
    logits, labels = _calibrated_logits_scaled(1.0)
    fitted = fit_temperature(logits, labels)
    assert 0.9 < fitted < 1.1


def test_fitted_temperature_never_loses_to_t_equals_one():
    logits, labels = _calibrated_logits_scaled(3.0, n=500, seed=5)
    fitted = fit_temperature(logits, labels)
    assert nll_at_temperature(logits, labels, fitted) <= nll(
        logits, labels
    ) + 1e-9


def test_scaling_never_changes_predictions():
    rng = np.random.default_rng(3)
    logits = rng.normal(size=(200, 5))
    before = predictions(softmax(logits))
    for temperature in (0.1, 2.0, 17.0):
        after = predictions(softmax(logits / temperature))
        assert (before == after).all()


def test_temperature_one_is_identity():
    logits = np.array([[1.0, -2.0, 0.5]])
    labels = np.array([0])
    assert nll_at_temperature(logits, labels, 1.0) == pytest.approx(
        nll(logits, labels)
    )


def test_high_temperature_flattens_toward_uniform():
    logits = np.array([[4.0, 0.0, -4.0]])
    flat = softmax(logits / 100000.0)
    assert np.allclose(flat, 1.0 / 3.0, atol=1e-4)


def test_nonpositive_temperature_rejected():
    logits = np.array([[1.0, 0.0]])
    labels = np.array([0])
    with pytest.raises(ValueError):
        nll_at_temperature(logits, labels, 0.0)
    with pytest.raises(ValueError):
        nll_at_temperature(logits, labels, -2.0)


def test_empty_fit_rejected():
    with pytest.raises(ValueError):
        fit_temperature(np.zeros((0, 3)), np.zeros(0, dtype=np.int64))


def test_bad_bracket_rejected():
    logits = np.array([[1.0, 0.0]])
    labels = np.array([0])
    with pytest.raises(ValueError):
        fit_temperature(logits, labels, lo=5.0, hi=2.0)


def test_fit_is_deterministic():
    logits, labels = _calibrated_logits_scaled(2.0, n=300, seed=9)
    assert fit_temperature(logits, labels) == fit_temperature(logits, labels)
