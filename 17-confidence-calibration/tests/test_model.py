import numpy as np
import pytest

from calibration.metrics import accuracy, softmax
from calibration.model import SoftmaxRegression


def _toy_separable():
    # two clearly separated clusters in 2-d
    x = np.array(
        [[3.0, 0.1], [2.5, -0.2], [3.2, 0.3], [-3.0, 0.2], [-2.7, -0.1], [-3.1, 0.0]]
    )
    y = np.array([0, 0, 0, 1, 1, 1])
    return x, y


def test_learns_separable_data():
    x, y = _toy_separable()
    model = SoftmaxRegression(2, 2).fit(x, y, epochs=500, lr=0.5, l2=0.0)
    assert accuracy(softmax(model.logits(x)), y) == pytest.approx(1.0)


def test_training_is_deterministic():
    x, y = _toy_separable()
    a = SoftmaxRegression(2, 2).fit(x, y, epochs=200, lr=0.3, l2=1e-3)
    b = SoftmaxRegression(2, 2).fit(x, y, epochs=200, lr=0.3, l2=1e-3)
    assert np.array_equal(a.weights, b.weights)
    assert np.array_equal(a.bias, b.bias)


def test_fit_continues_from_current_weights():
    x, y = _toy_separable()
    whole = SoftmaxRegression(2, 2).fit(x, y, epochs=300, lr=0.3, l2=1e-3)
    split = SoftmaxRegression(2, 2)
    split.fit(x, y, epochs=100, lr=0.3, l2=1e-3)
    split.fit(x, y, epochs=200, lr=0.3, l2=1e-3)
    assert np.allclose(whole.weights, split.weights)
    assert np.allclose(whole.bias, split.bias)


def test_l2_shrinks_weights():
    x, y = _toy_separable()
    loose = SoftmaxRegression(2, 2).fit(x, y, epochs=500, lr=0.5, l2=0.0)
    tight = SoftmaxRegression(2, 2).fit(x, y, epochs=500, lr=0.5, l2=0.1)
    assert np.linalg.norm(tight.weights) < np.linalg.norm(loose.weights)


def test_gradient_matches_numeric_gradient():
    rng = np.random.default_rng(2)
    x = rng.normal(size=(12, 5))
    y = rng.integers(3, size=12)
    l2, eps = 0.01, 1e-6

    model = SoftmaxRegression(5, 3)
    model.weights = rng.normal(size=(5, 3)) * 0.3
    model.bias = rng.normal(size=3) * 0.3

    # one plain gradient step recovered from the parameter delta
    before_w = model.weights.copy()
    stepped = SoftmaxRegression(5, 3)
    stepped.weights = model.weights.copy()
    stepped.bias = model.bias.copy()
    stepped.fit(x, y, epochs=1, lr=1.0, l2=l2)
    analytic = before_w - stepped.weights  # lr * grad_w with lr = 1

    numeric = np.zeros_like(model.weights)
    for i in range(5):
        for j in range(3):
            probe = SoftmaxRegression(5, 3)
            probe.weights = model.weights.copy()
            probe.bias = model.bias.copy()
            probe.weights[i, j] += eps
            up = probe.loss(x, y, l2)
            probe.weights[i, j] -= 2 * eps
            down = probe.loss(x, y, l2)
            numeric[i, j] = (up - down) / (2 * eps)
    assert np.allclose(analytic, numeric, atol=1e-6)


def test_loss_decreases_over_training():
    x, y = _toy_separable()
    model = SoftmaxRegression(2, 2)
    start = model.loss(x, y, 0.0)
    model.fit(x, y, epochs=50, lr=0.3, l2=0.0)
    assert model.loss(x, y, 0.0) < start


def test_zero_init_predicts_uniform():
    model = SoftmaxRegression(3, 4)
    probs = softmax(model.logits(np.ones((2, 3))))
    assert np.allclose(probs, 0.25)


def test_rejects_bad_shapes():
    with pytest.raises(ValueError):
        SoftmaxRegression(0, 2)
    with pytest.raises(ValueError):
        SoftmaxRegression(3, 1)
    model = SoftmaxRegression(2, 2)
    with pytest.raises(ValueError):
        model.fit(np.zeros((0, 2)), np.zeros(0, dtype=np.int64), 1, 0.1, 0.0)
    with pytest.raises(ValueError):
        model.fit(np.zeros((2, 2)), np.zeros(3, dtype=np.int64), 1, 0.1, 0.0)
