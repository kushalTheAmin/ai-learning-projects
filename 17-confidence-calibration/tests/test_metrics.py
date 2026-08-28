import numpy as np
import pytest

from calibration.metrics import (
    BinRow,
    accuracy,
    brier,
    confidence,
    ece,
    log_softmax,
    mce,
    nll,
    predictions,
    reliability_table,
    selective,
    softmax,
)


def test_softmax_rows_sum_to_one():
    logits = np.array([[1.0, 2.0, 3.0], [-1.0, 0.0, 1.0]])
    probs = softmax(logits)
    assert np.allclose(probs.sum(axis=1), 1.0)
    assert (probs > 0).all()


def test_softmax_stable_at_huge_logits():
    logits = np.array([[1e4, 1e4 - 1.0], [-1e4, -1e4 + 1.0]])
    probs = softmax(logits)
    assert np.isfinite(probs).all()
    assert np.allclose(probs.sum(axis=1), 1.0)


def test_log_softmax_matches_log_of_softmax():
    logits = np.array([[0.5, -2.0, 1.5, 0.0]])
    assert np.allclose(log_softmax(logits), np.log(softmax(logits)))


def test_nll_hand_case():
    # two classes with equal logits: -log(0.5) per row
    logits = np.zeros((3, 2))
    labels = np.array([0, 1, 0])
    assert nll(logits, labels) == pytest.approx(np.log(2.0))


def test_nll_rewards_confident_truth():
    labels = np.array([0])
    confident = np.array([[5.0, 0.0]])
    hedged = np.array([[1.0, 0.0]])
    assert nll(confident, labels) < nll(hedged, labels)


def test_predictions_and_confidence():
    probs = np.array([[0.7, 0.2, 0.1], [0.1, 0.1, 0.8]])
    assert predictions(probs).tolist() == [0, 2]
    assert np.allclose(confidence(probs), [0.7, 0.8])


def test_accuracy_hand_case():
    probs = np.array([[0.9, 0.1], [0.4, 0.6], [0.8, 0.2]])
    labels = np.array([0, 0, 0])
    assert accuracy(probs, labels) == pytest.approx(2.0 / 3.0)


def test_brier_hand_cases():
    perfect = np.array([[1.0, 0.0]])
    worst = np.array([[0.0, 1.0]])
    labels = np.array([0])
    assert brier(perfect, labels) == pytest.approx(0.0)
    assert brier(worst, labels) == pytest.approx(2.0)
    uniform = np.array([[0.5, 0.5]])
    assert brier(uniform, labels) == pytest.approx(0.5)


def test_reliability_bins_partition_everything():
    rng = np.random.default_rng(7)
    logits = rng.normal(size=(500, 4))
    probs = softmax(logits)
    labels = rng.integers(4, size=500)
    rows = reliability_table(probs, labels, n_bins=10)
    assert sum(r.count for r in rows) == 500
    for r in rows:
        assert r.lo <= r.mean_confidence <= r.hi or r.mean_confidence == r.hi


def test_confidence_of_exactly_one_lands_in_last_bin():
    probs = np.array([[1.0, 0.0]])
    labels = np.array([0])
    rows = reliability_table(probs, labels, n_bins=10)
    assert len(rows) == 1
    assert rows[0].lo == pytest.approx(0.9)
    assert rows[0].count == 1
    assert rows[0].accuracy == pytest.approx(1.0)


def test_ece_hand_case():
    # one bin: 4 predictions at confidence 0.8, half of them right
    probs = np.array([[0.8, 0.2]] * 4)
    labels = np.array([0, 0, 1, 1])
    assert ece(probs, labels, n_bins=10) == pytest.approx(0.3)
    assert mce(probs, labels, n_bins=10) == pytest.approx(0.3)


def test_ece_weights_bins_by_count():
    # 3 rows at conf 0.95 all correct (gap 0.05), 1 row at conf 0.55
    # correct (gap -0.45): ece = (3*0.05 + 1*0.45)/4
    probs = np.array([[0.95, 0.05]] * 3 + [[0.55, 0.45]])
    labels = np.array([0, 0, 0, 0])
    assert ece(probs, labels, n_bins=10) == pytest.approx((3 * 0.05 + 0.45) / 4)
    assert mce(probs, labels, n_bins=10) == pytest.approx(0.45)


def test_perfectly_calibrated_bins_score_zero():
    # 10 rows at confidence 0.7, exactly 7 correct
    probs = np.array([[0.7, 0.3]] * 10)
    labels = np.array([0] * 7 + [1] * 3)
    assert ece(probs, labels, n_bins=10) == pytest.approx(0.0)


def test_gap_sign_is_overconfidence():
    row = BinRow(lo=0.8, hi=0.9, count=5, mean_confidence=0.85, accuracy=0.6)
    assert row.gap == pytest.approx(0.25)


def test_selective_policy():
    probs = np.array([[0.95, 0.05], [0.55, 0.45], [0.85, 0.15], [0.6, 0.4]])
    labels = np.array([0, 1, 1, 0])
    row = selective(probs, labels, threshold=0.8)
    assert row.answered == 2
    assert row.coverage == pytest.approx(0.5)
    assert row.accuracy_answered == pytest.approx(0.5)


def test_selective_answers_nothing():
    probs = np.array([[0.6, 0.4]])
    labels = np.array([0])
    row = selective(probs, labels, threshold=0.99)
    assert row.answered == 0
    assert row.accuracy_answered is None


def test_selective_threshold_is_inclusive():
    probs = np.array([[0.9, 0.1]])
    labels = np.array([0])
    assert selective(probs, labels, threshold=0.9).answered == 1


def test_single_item_metrics():
    probs = np.array([[0.6, 0.4]])
    labels = np.array([0])
    assert accuracy(probs, labels) == pytest.approx(1.0)
    assert ece(probs, labels) == pytest.approx(0.4)


def test_empty_input_raises():
    empty = np.zeros((0, 3))
    labels = np.zeros(0, dtype=np.int64)
    for fn in (accuracy, brier, ece, mce, nll):
        with pytest.raises(ValueError):
            fn(empty, labels)


def test_mismatched_lengths_raise():
    with pytest.raises(ValueError):
        accuracy(np.ones((2, 2)) / 2, np.array([0]))
