"""End to end: generate data, train, calibrate, and check the claims the
project makes actually hold on a fresh seeded run."""

import importlib.util
from pathlib import Path

import numpy as np
import pytest

from calibration.data import DRIFT_FILLER, LABELS, generate_tickets, labels_array
from calibration.features import build_vocabulary, vectorize
from calibration.metrics import accuracy, ece, nll, predictions, selective, softmax
from calibration.model import SoftmaxRegression
from calibration.temperature import fit_temperature


@pytest.fixture(scope="module")
def pipeline():
    train = generate_tickets(300, seed=101, ambiguity=0.20)
    val = generate_tickets(300, seed=202, ambiguity=0.20)
    test = generate_tickets(600, seed=303, ambiguity=0.20)
    vocabulary = build_vocabulary([t.text for t in train])
    x_train = vectorize([t.text for t in train], vocabulary)
    x_val = vectorize([t.text for t in val], vocabulary)
    x_test = vectorize([t.text for t in test], vocabulary)
    model = SoftmaxRegression(len(vocabulary), len(LABELS))
    model.fit(x_train, labels_array(train), epochs=2000, lr=0.5, l2=1e-4)
    return {
        "model": model,
        "vocabulary": vocabulary,
        "logits_val": model.logits(x_val),
        "logits_test": model.logits(x_test),
        "y_train": labels_array(train),
        "y_val": labels_array(val),
        "y_test": labels_array(test),
        "x_train": x_train,
    }


def test_model_beats_chance_on_held_out_data(pipeline):
    probs = softmax(pipeline["logits_test"])
    assert accuracy(probs, pipeline["y_test"]) > 0.6


def test_overfit_model_is_overconfident(pipeline):
    probs = softmax(pipeline["logits_test"])
    conf = probs.max(axis=1).mean()
    acc = accuracy(probs, pipeline["y_test"])
    assert conf > acc + 0.05
    assert ece(probs, pipeline["y_test"]) > 0.05


def test_fitted_temperature_is_above_one(pipeline):
    fitted = fit_temperature(pipeline["logits_val"], pipeline["y_val"])
    assert fitted > 1.2


def test_scaling_improves_val_nll_and_test_ece(pipeline):
    fitted = fit_temperature(pipeline["logits_val"], pipeline["y_val"])
    assert nll(pipeline["logits_val"] / fitted, pipeline["y_val"]) < nll(
        pipeline["logits_val"], pipeline["y_val"]
    )
    before = ece(softmax(pipeline["logits_test"]), pipeline["y_test"])
    after = ece(softmax(pipeline["logits_test"] / fitted), pipeline["y_test"])
    assert after < before


def test_scaling_changes_no_prediction(pipeline):
    fitted = fit_temperature(pipeline["logits_val"], pipeline["y_val"])
    before = predictions(softmax(pipeline["logits_test"]))
    after = predictions(softmax(pipeline["logits_test"] / fitted))
    assert (before == after).all()


def test_calibrated_scores_keep_the_policy_promise(pipeline):
    """Answer iff confidence >= 0.9 promises ~90% accuracy on the
    answered slice. The overconfident raw scores break that promise;
    the calibrated ones keep it (conservatively is fine)."""
    fitted = fit_temperature(pipeline["logits_val"], pipeline["y_val"])
    raw = selective(softmax(pipeline["logits_test"]), pipeline["y_test"], 0.9)
    cal = selective(
        softmax(pipeline["logits_test"] / fitted), pipeline["y_test"], 0.9
    )
    assert raw.accuracy_answered is not None
    assert cal.accuracy_answered is not None
    assert raw.accuracy_answered < 0.9
    assert cal.accuracy_answered >= 0.9


def test_shifted_traffic_is_harder_and_less_calibrated(pipeline):
    shifted = generate_tickets(
        600, seed=404, ambiguity=0.35, filler_bank=DRIFT_FILLER
    )
    x_shift = vectorize([t.text for t in shifted], pipeline["vocabulary"])
    y_shift = labels_array(shifted)
    logits = pipeline["model"].logits(x_shift)
    probs = softmax(logits)
    assert accuracy(probs, y_shift) < accuracy(
        softmax(pipeline["logits_test"]), pipeline["y_test"]
    )
    assert ece(probs, y_shift) > ece(
        softmax(pipeline["logits_test"]), pipeline["y_test"]
    )


def test_training_is_reproducible_end_to_end(pipeline):
    rerun = SoftmaxRegression(len(pipeline["vocabulary"]), len(LABELS))
    rerun.fit(pipeline["x_train"], pipeline["y_train"], epochs=2000, lr=0.5, l2=1e-4)
    assert np.array_equal(rerun.weights, pipeline["model"].weights)


def test_entry_point_runs_and_reports(capsys):
    # load by path: sibling projects on sys.path also have a main.py
    path = Path(__file__).resolve().parents[1] / "main.py"
    spec = importlib.util.spec_from_file_location("calibration_main", path)
    entry_point = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(entry_point)
    entry_point.main()
    out = capsys.readouterr().out
    assert "fitted temperature T =" in out
    assert "(unchanged by construction)" in out
    assert "distribution shift breaks the fitted temperature" in out
