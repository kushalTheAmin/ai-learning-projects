"""Does a confidence score mean what it says? Train a softmax classifier
on synthetic support tickets, measure confidence against actual accuracy
(reliability bins, ECE), fit one temperature on the validation set, and
price what miscalibration does to a confidence-thresholded escalation
policy and what happens under distribution shift.

Deterministic end to end: seeded data, zero-init full-batch training,
convex 1-d temperature search. Same output every run."""

import numpy as np

from calibration.data import (
    DRIFT_FILLER,
    LABELS,
    generate_tickets,
    labels_array,
)
from calibration.features import build_vocabulary, vectorize
from calibration.metrics import (
    accuracy,
    brier,
    ece,
    mce,
    nll,
    reliability_table,
    selective,
    softmax,
)
from calibration.model import SoftmaxRegression
from calibration.temperature import fit_temperature, nll_at_temperature

N_TRAIN, N_VAL, N_TEST = 600, 400, 1200
AMBIGUITY = 0.20
SHIFT_AMBIGUITY = 0.35
LR, L2 = 0.5, 1e-4
CHECKPOINTS = (50, 100, 200, 400, 800, 1600, 3200)
THRESHOLDS = (0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99)
BINS = 10


def print_reliability(probs: np.ndarray, labels: np.ndarray, title: str) -> None:
    print(f"\n  reliability, {title} ({BINS} equal-width confidence bins)")
    print("  bin           count  mean conf  accuracy    gap")
    for row in reliability_table(probs, labels, BINS):
        print(
            f"  [{row.lo:.2f},{row.hi:.2f})  {row.count:5d}"
            f"      {row.mean_confidence:.3f}     {row.accuracy:.3f}"
            f"  {row.gap:+.3f}"
        )


def main() -> None:
    train = generate_tickets(N_TRAIN, seed=101, ambiguity=AMBIGUITY)
    val = generate_tickets(N_VAL, seed=202, ambiguity=AMBIGUITY)
    test = generate_tickets(N_TEST, seed=303, ambiguity=AMBIGUITY)
    shifted = generate_tickets(
        N_TEST,
        seed=404,
        ambiguity=SHIFT_AMBIGUITY,
        filler_bank=DRIFT_FILLER,
    )

    vocabulary = build_vocabulary([t.text for t in train])
    x_train = vectorize([t.text for t in train], vocabulary)
    x_val = vectorize([t.text for t in val], vocabulary)
    x_test = vectorize([t.text for t in test], vocabulary)
    x_shift = vectorize([t.text for t in shifted], vocabulary)
    y_train = labels_array(train)
    y_val = labels_array(val)
    y_test = labels_array(test)
    y_shift = labels_array(shifted)

    print("== setup ==")
    print(f"classes: {', '.join(LABELS)}")
    print(
        f"tickets: {N_TRAIN} train / {N_VAL} val / {N_TEST} test"
        f" / {N_TEST} shifted, ambiguity {AMBIGUITY:.2f}"
        f" (shifted {SHIFT_AMBIGUITY:.2f} + unseen filler vocabulary)"
    )
    print(f"vocabulary from train only: {len(vocabulary)} tokens")

    print("\n== 1. accuracy converges, calibration keeps drifting ==")
    print("epochs  train acc  train nll  val acc  val nll  val ece")
    model = SoftmaxRegression(len(vocabulary), len(LABELS))
    done = 0
    for point in CHECKPOINTS:
        model.fit(x_train, y_train, epochs=point - done, lr=LR, l2=L2)
        done = point
        p_train = softmax(model.logits(x_train))
        p_val = softmax(model.logits(x_val))
        print(
            f"{point:6d}      {accuracy(p_train, y_train):.3f}"
            f"      {nll(model.logits(x_train), y_train):.3f}"
            f"    {accuracy(p_val, y_val):.3f}"
            f"    {nll(model.logits(x_val), y_val):.3f}"
            f"    {ece(p_val, y_val, BINS):.3f}"
        )

    logits_val = model.logits(x_val)
    logits_test = model.logits(x_test)
    probs_test = softmax(logits_test)

    print("\n== 2. the raw model on held-out test ==")
    print(
        f"accuracy {accuracy(probs_test, y_test):.3f}"
        f"  nll {nll(logits_test, y_test):.3f}"
        f"  brier {brier(probs_test, y_test):.3f}"
        f"  ece {ece(probs_test, y_test, BINS):.3f}"
        f"  mce {mce(probs_test, y_test, BINS):.3f}"
    )
    print_reliability(probs_test, y_test, "raw")

    print("\n== 3. temperature scaling, fitted on validation ==")
    temperature = fit_temperature(logits_val, y_val)
    print(f"fitted temperature T = {temperature:.3f}")
    print(
        f"val nll {nll(logits_val, y_val):.3f} -> "
        f"{nll_at_temperature(logits_val, y_val, temperature):.3f}"
    )
    probs_cal = softmax(logits_test / temperature)
    print(
        f"test after scaling: accuracy {accuracy(probs_cal, y_test):.3f}"
        f" (unchanged by construction)"
        f"  nll {nll(logits_test / temperature, y_test):.3f}"
        f"  brier {brier(probs_cal, y_test):.3f}"
        f"  ece {ece(probs_cal, y_test, BINS):.3f}"
        f"  mce {mce(probs_cal, y_test, BINS):.3f}"
    )
    print_reliability(probs_cal, y_test, "temperature-scaled")

    print("\n== 4. what miscalibration costs an escalation policy ==")
    print("answer iff confidence >= t, escalate the rest (test set)")
    print("     t   raw cover  raw acc  cal cover  cal acc")
    for threshold in THRESHOLDS:
        raw = selective(probs_test, y_test, threshold)
        cal = selective(probs_cal, y_test, threshold)
        raw_acc = "    -" if raw.accuracy_answered is None else f"{raw.accuracy_answered:.3f}"
        cal_acc = "    -" if cal.accuracy_answered is None else f"{cal.accuracy_answered:.3f}"
        print(
            f"  {threshold:.2f}       {raw.coverage:.3f}    {raw_acc}"
            f"      {cal.coverage:.3f}    {cal_acc}"
        )

    print("\n== 5. distribution shift breaks the fitted temperature ==")
    logits_shift = model.logits(x_shift)
    probs_shift = softmax(logits_shift)
    probs_shift_cal = softmax(logits_shift / temperature)
    oracle = fit_temperature(logits_shift, y_shift)
    probs_shift_oracle = softmax(logits_shift / oracle)
    print(
        f"shifted accuracy {accuracy(probs_shift, y_shift):.3f}"
        f" (test was {accuracy(probs_test, y_test):.3f})"
    )
    print(
        f"shifted ece: raw {ece(probs_shift, y_shift, BINS):.3f}"
        f"  with val T={temperature:.3f} {ece(probs_shift_cal, y_shift, BINS):.3f}"
        f"  with oracle T={oracle:.3f} {ece(probs_shift_oracle, y_shift, BINS):.3f}"
    )
    print(
        f"shifted nll: raw {nll(logits_shift, y_shift):.3f}"
        f"  with val T {nll(logits_shift / temperature, y_shift):.3f}"
        f"  with oracle T {nll(logits_shift / oracle, y_shift):.3f}"
    )
    raw_09 = selective(probs_shift, y_shift, 0.9)
    cal_09 = selective(probs_shift_cal, y_shift, 0.9)
    raw_line = "-" if raw_09.accuracy_answered is None else f"{raw_09.accuracy_answered:.3f}"
    cal_line = "-" if cal_09.accuracy_answered is None else f"{cal_09.accuracy_answered:.3f}"
    print(
        f"policy at t=0.90 on shifted traffic: raw answers"
        f" {raw_09.coverage:.3f} at {raw_line} accuracy,"
        f" val-T answers {cal_09.coverage:.3f} at {cal_line}"
    )


if __name__ == "__main__":
    main()
