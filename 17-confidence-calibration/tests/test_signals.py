import importlib.util
from pathlib import Path

import numpy as np
import pytest

from calibration.data import DRIFT_FILLER, LABELS, generate_tickets, labels_array
from calibration.features import build_vocabulary, vectorize
from calibration.metrics import accuracy, predictions, softmax
from calibration.model import SoftmaxRegression
from calibration.signals import (
    aurc,
    coverage_at_risk,
    logit_margin,
    margin,
    max_softmax,
    negative_entropy,
    oracle_aurc,
    pair_disagreement,
    random_aurc,
    risk_at_coverage,
    risk_coverage,
)
from calibration.temperature import fit_temperature

_ROOT = Path(__file__).resolve().parents[1]


def test_margin_is_top_minus_runner_up():
    probs = np.array([[0.5, 0.3, 0.2], [0.4, 0.4, 0.2]])
    assert np.allclose(margin(probs), [0.2, 0.0])


def test_margin_ignores_column_order():
    probs = np.array([[0.2, 0.5, 0.3]])
    assert np.allclose(margin(probs), [0.2])


def test_signals_reject_single_column_and_empty_input():
    for fn in (max_softmax, margin, negative_entropy, logit_margin):
        with pytest.raises(ValueError):
            fn(np.array([[1.0], [1.0]]))
        with pytest.raises(ValueError):
            fn(np.zeros((0, 3)))


def test_negative_entropy_extremes():
    onehot = np.array([[1.0, 0.0, 0.0, 0.0]])
    uniform = np.full((1, 4), 0.25)
    assert negative_entropy(onehot)[0] == 0.0
    assert np.isclose(negative_entropy(uniform)[0], -np.log(4))
    assert np.isfinite(negative_entropy(onehot)).all()


def test_all_three_signals_agree_on_two_classes():
    """With two classes the top probability determines the whole row, so
    the three probability signals must induce the same ordering."""
    rng = np.random.default_rng(7)
    top = rng.uniform(0.5, 1.0, size=50)
    probs = np.column_stack([top, 1.0 - top])
    assert pair_disagreement(max_softmax(probs), margin(probs)) == 0.0
    assert pair_disagreement(max_softmax(probs), negative_entropy(probs)) == 0.0


def test_risk_coverage_hand_case():
    signal = np.array([3.0, 2.0, 1.0])
    correct = np.array([True, False, True])
    curve = risk_coverage(signal, correct)
    assert np.allclose(curve.coverage, [1 / 3, 2 / 3, 1.0])
    assert np.allclose(curve.risk, [0.0, 0.5, 1 / 3])


def test_risk_coverage_breaks_ties_by_input_index():
    signal = np.array([1.0, 1.0])
    correct = np.array([False, True])
    curve = risk_coverage(signal, correct)
    assert np.allclose(curve.risk, [1.0, 0.5])


def test_risk_coverage_rejects_bad_shapes():
    with pytest.raises(ValueError):
        risk_coverage(np.array([1.0, 2.0]), np.array([True]))
    with pytest.raises(ValueError):
        risk_coverage(np.array([]), np.array([], dtype=bool))


def test_aurc_extremes():
    signal = np.array([2.0, 1.0])
    assert aurc(signal, np.array([True, True])) == 0.0
    assert aurc(signal, np.array([False, False])) == 1.0


def test_perfect_signal_hits_the_oracle():
    correct = np.array([True, False, True, False, True])
    perfect = correct.astype(np.float64)
    assert np.isclose(aurc(perfect, correct), oracle_aurc(correct))


def test_oracle_aurc_hand_case():
    # 2 correct of 4: prefix errors 0, 0, 1, 2 -> risks 0, 0, 1/3, 1/2
    correct = np.array([True, False, True, False])
    assert np.isclose(oracle_aurc(correct), (0.0 + 0.0 + 1 / 3 + 0.5) / 4)


def test_no_signal_beats_the_oracle():
    rng = np.random.default_rng(11)
    correct = rng.random(200) < 0.7
    for _ in range(5):
        signal = rng.normal(size=200)
        assert aurc(signal, correct) >= oracle_aurc(correct) - 1e-12


def test_coverage_at_risk_hand_case():
    signal = np.array([4.0, 3.0, 2.0, 1.0])
    correct = np.array([True, True, False, False])
    point = coverage_at_risk(signal, correct, 0.05)
    assert point is not None
    assert point.answered == 2
    assert point.risk == 0.0
    # a 1/3 budget admits the third item but not the half-risk full prefix
    wider = coverage_at_risk(signal, correct, 1 / 3)
    assert wider is not None
    assert wider.answered == 3


def test_coverage_at_risk_takes_the_widest_prefix_after_a_dip():
    """Risk is not monotone in coverage; the widest qualifying prefix
    wins even when a narrower one also qualifies."""
    signal = np.array([4.0, 3.0, 2.0, 1.0])
    correct = np.array([True, False, True, True])
    point = coverage_at_risk(signal, correct, 0.25)
    assert point is not None
    assert point.answered == 4
    assert np.isclose(point.risk, 0.25)


def test_coverage_at_risk_unreachable_returns_none():
    signal = np.array([2.0, 1.0])
    correct = np.array([False, True])
    assert coverage_at_risk(signal, correct, 0.0) is None


def test_risk_at_coverage_hand_case():
    signal = np.array([3.0, 2.0, 1.0])
    correct = np.array([True, False, True])
    assert risk_at_coverage(signal, correct, 1.0) == pytest.approx(1 / 3)
    assert risk_at_coverage(signal, correct, 0.5) == pytest.approx(0.5)
    with pytest.raises(ValueError):
        risk_at_coverage(signal, correct, 0.0)


def test_pair_disagreement_extremes_and_ties():
    a = np.array([3.0, 2.0, 1.0])
    assert pair_disagreement(a, a) == 0.0
    assert pair_disagreement(a, -a) == 1.0
    assert pair_disagreement(a, a + 100.0) == 0.0
    # a tie under one signal is not a conflict
    assert pair_disagreement(np.array([1.0, 1.0]), np.array([1.0, 2.0])) == 0.0
    with pytest.raises(ValueError):
        pair_disagreement(np.array([1.0]), np.array([1.0]))


def test_logit_margin_ordering_survives_temperature():
    rng = np.random.default_rng(3)
    logits = rng.normal(size=(40, 4)) * 5.0
    assert pair_disagreement(logit_margin(logits), logit_margin(logits / 3.7)) == 0.0


def test_max_softmax_ordering_can_flip_under_temperature():
    """Constructed pair: a wins on max softmax at T=1, b wins at T=4,
    because scaling compresses a's lone large gap faster than b's."""
    logits = np.array(
        [
            [4.0, 0.0, 0.0, 0.0],
            [10.0, 8.0, -50.0, -50.0],
        ]
    )
    raw = max_softmax(softmax(logits))
    cooled = max_softmax(softmax(logits / 4.0))
    assert raw[0] > raw[1]
    assert cooled[0] < cooled[1]


@pytest.fixture(scope="module")
def trained():
    train = generate_tickets(300, seed=101, ambiguity=0.20)
    test = generate_tickets(600, seed=303, ambiguity=0.20)
    vocabulary = build_vocabulary([t.text for t in train])
    model = SoftmaxRegression(len(vocabulary), len(LABELS))
    model.fit(
        vectorize([t.text for t in train], vocabulary),
        labels_array(train),
        epochs=2000,
        lr=0.5,
        l2=1e-4,
    )
    probs = softmax(model.logits(vectorize([t.text for t in test], vocabulary)))
    y_test = labels_array(test)
    return probs, predictions(probs) == y_test, y_test


def test_every_signal_beats_a_random_ordering(trained):
    """A constant signal degenerates to input order, whose AURC sits
    near the overall error rate; a working trust signal must land well
    below that and above the oracle floor."""
    probs, correct, y_test = trained
    error_rate = 1.0 - accuracy(probs, y_test)
    floor = oracle_aurc(correct)
    for fn in (max_softmax, margin, negative_entropy):
        area = aurc(fn(probs), correct)
        assert floor <= area < 0.75 * error_rate


def test_signals_disagree_but_only_a_little(trained):
    probs, _, _ = trained
    rate = pair_disagreement(max_softmax(probs), margin(probs))
    assert 0.0 < rate < 0.25


def test_random_aurc_is_the_base_error_rate(trained):
    """An ordering that carries no information answers a random prefix at
    every coverage, so its expected prefix risk is the base error rate at
    every k, and its aurc is that rate."""
    probs, correct, y_test = trained
    assert random_aurc(correct) == pytest.approx(1.0 - accuracy(probs, y_test))


def test_random_aurc_matches_actual_random_orderings(trained):
    """The analytic baseline against the thing it stands in for."""
    _, correct, _ = trained
    rng = np.random.default_rng(5)
    draws = [aurc(rng.permutation(correct.shape[0]).astype(np.float64), correct)
             for _ in range(200)]
    assert np.mean(draws) == pytest.approx(random_aurc(correct), abs=0.01)


def test_random_aurc_rejects_empty_input():
    with pytest.raises(ValueError):
        random_aurc(np.array([], dtype=bool))


def test_oracle_gap_needs_both_ends_of_the_span(trained):
    """A signal's distance from the oracle floor is a fraction of nothing
    until you name the other end. The signal's own aurc is not that end:
    it already contains the floor, so dividing by it prices the gap
    against a span no ordering could ever cross."""
    probs, correct, _ = trained
    best = min(aurc(fn(probs), correct)
               for fn in (max_softmax, margin, negative_entropy))
    floor, baseline = oracle_aurc(correct), random_aurc(correct)
    missed = (best - floor) / (baseline - floor)
    against_own_aurc = (best - floor) / best
    assert 0.0 < missed < 1.0
    # the two normalizations are not interchangeable, which is the bug
    assert against_own_aurc > missed + 0.2


@pytest.fixture(scope="module")
def published():
    """The full signals_main.py pipeline: the fraction of the achievable
    ordering the best signal closes, in-distribution and under shift."""
    train = generate_tickets(600, seed=101, ambiguity=0.20)
    val = generate_tickets(400, seed=202, ambiguity=0.20)
    test = generate_tickets(1200, seed=303, ambiguity=0.20)
    shifted = generate_tickets(
        1200, seed=404, ambiguity=0.35, filler_bank=DRIFT_FILLER
    )
    vocabulary = build_vocabulary([t.text for t in train])
    model = SoftmaxRegression(len(vocabulary), len(LABELS))
    model.fit(
        vectorize([t.text for t in train], vocabulary),
        labels_array(train),
        epochs=3200,
        lr=0.5,
        l2=1e-4,
    )
    fit_temperature(model.logits(vectorize([t.text for t in val], vocabulary)),
                    labels_array(val))

    def closed(tickets):
        probs = softmax(
            model.logits(vectorize([t.text for t in tickets], vocabulary))
        )
        correct = predictions(probs) == labels_array(tickets)
        best = min(aurc(fn(probs), correct)
                   for fn in (max_softmax, margin, negative_entropy))
        floor, baseline = oracle_aurc(correct), random_aurc(correct)
        return (baseline - best) / (baseline - floor)

    return closed(test), closed(shifted)


def test_readme_prices_the_oracle_gap_against_the_uninformative_baseline(published):
    """The readme publishes how much of the achievable mistake-ranking
    these signals miss. That fraction must be the one measured against an
    uninformative ordering, not against the signal's own aurc."""
    readme = (_ROOT / "README.md").read_text(encoding="utf-8")
    body = readme.split("## fixes")[0]
    closed_test, _ = published
    assert f"{closed_test:.3f}" in body or f"{closed_test:.1%}" in body, closed_test
    assert "two thirds of the achievable" not in body.lower()


def test_shift_costs_the_signals_ordering_under_the_published_normalization(published):
    """The readme says the signals capture even less of the achievable
    ordering under shift. Whatever normalization it publishes has to be
    the one that makes that sentence true."""
    closed_test, closed_shift = published
    assert closed_shift < closed_test


def test_entry_point_runs_and_reports(capsys):
    # load by path: sibling projects on sys.path also have entry modules
    path = Path(__file__).resolve().parents[1] / "signals_main.py"
    spec = importlib.util.spec_from_file_location("calibration_signals_main", path)
    entry_point = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(entry_point)
    entry_point.main()
    out = capsys.readouterr().out
    assert "three signals, three orderings" in out
    assert "risk-coverage on raw test scores" in out
    assert "temperature-invariant by construction" in out
    assert "oracle aurc" in out
