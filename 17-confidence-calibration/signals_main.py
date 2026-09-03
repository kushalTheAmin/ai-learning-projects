"""Does it matter which cheap trust signal ranks the predictions? Train
the same overconfident classifier as main.py, then compare max softmax,
margin (top1 minus top2), and negative entropy as orderings: how often
they disagree on pairs, what each one's risk-coverage curve and AURC
look like, what coverage each buys at a 5% error budget, whether
temperature scaling moves the orderings, and how each survives
distribution shift.

Deterministic end to end: same seeds, same zero-init training, same
convex temperature search as main.py. Same output every run."""

import numpy as np

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
    risk_at_coverage,
)
from calibration.temperature import fit_temperature

N_TRAIN, N_VAL, N_TEST = 600, 400, 1200
AMBIGUITY = 0.20
SHIFT_AMBIGUITY = 0.35
LR, L2 = 0.5, 1e-4
EPOCHS = 3200
RISK_BUDGET = 0.05
COVERAGES = (0.5, 0.6, 0.7, 0.8, 0.9, 1.0)

SIGNALS = (
    ("max softmax", max_softmax),
    ("margin", margin),
    ("neg entropy", negative_entropy),
)


def print_risk_table(probs: np.ndarray, correct: np.ndarray, title: str) -> None:
    print(f"\n  risk at coverage, {title} (error rate of the trusted prefix)")
    header = "  signal        " + "".join(f"   c={c:.1f}" for c in COVERAGES) + "     aurc"
    print(header)
    for name, fn in SIGNALS:
        values = fn(probs)
        cells = "".join(
            f"  {risk_at_coverage(values, correct, c):.3f}" for c in COVERAGES
        )
        print(f"  {name:<12}{cells}    {aurc(values, correct):.4f}")
    print(f"  oracle aurc at this accuracy: {oracle_aurc(correct):.4f}")


def print_budget_row(probs: np.ndarray, correct: np.ndarray) -> None:
    print(f"\n  widest coverage inside a {RISK_BUDGET:.0%} error budget")
    for name, fn in SIGNALS:
        point = coverage_at_risk(fn(probs), correct, RISK_BUDGET)
        if point is None:
            print(f"  {name:<12}  unreachable at any coverage")
        else:
            print(
                f"  {name:<12}  answers {point.coverage:.3f}"
                f" ({point.answered} of {point.total}) at risk {point.risk:.3f}"
            )


def main() -> None:
    train = generate_tickets(N_TRAIN, seed=101, ambiguity=AMBIGUITY)
    val = generate_tickets(N_VAL, seed=202, ambiguity=AMBIGUITY)
    test = generate_tickets(N_TEST, seed=303, ambiguity=AMBIGUITY)
    shifted = generate_tickets(
        N_TEST, seed=404, ambiguity=SHIFT_AMBIGUITY, filler_bank=DRIFT_FILLER
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

    model = SoftmaxRegression(len(vocabulary), len(LABELS))
    model.fit(x_train, y_train, epochs=EPOCHS, lr=LR, l2=L2)
    logits_test = model.logits(x_test)
    probs_test = softmax(logits_test)
    correct_test = predictions(probs_test) == y_test
    temperature = fit_temperature(model.logits(x_val), y_val)
    logits_cal = logits_test / temperature
    probs_cal = softmax(logits_cal)

    print("== setup ==")
    print(
        f"same pipeline as main.py: {N_TRAIN} train / {N_VAL} val /"
        f" {N_TEST} test, {EPOCHS} epochs, T fitted on val = {temperature:.3f}"
    )
    print(
        f"test accuracy {accuracy(probs_test, y_test):.3f}"
        f" -> full-coverage risk {1.0 - accuracy(probs_test, y_test):.3f}"
    )

    print("\n== 1. three signals, three orderings ==")
    print("pairwise ordering disagreement on raw test probabilities")
    print("(fraction of item pairs ranked in opposite directions)")
    for (name_a, fn_a), (name_b, fn_b) in (
        (SIGNALS[0], SIGNALS[1]),
        (SIGNALS[0], SIGNALS[2]),
        (SIGNALS[1], SIGNALS[2]),
    ):
        rate = pair_disagreement(fn_a(probs_test), fn_b(probs_test))
        print(f"  {name_a} vs {name_b}: {rate:.4f}")
    wrong = int((~correct_test).sum())
    print(f"  ({wrong} of {N_TEST} test predictions are wrong; the signals")
    print("   compete on how late those wrong ones appear in the ordering)")

    print("\n== 2. risk-coverage on raw test scores ==")
    print_risk_table(probs_test, correct_test, "raw")
    print_budget_row(probs_test, correct_test)

    print("\n== 3. does temperature scaling move the orderings? ==")
    print(f"pairwise disagreement, raw vs T={temperature:.3f} version of the same signal")
    for name, fn in SIGNALS:
        rate = pair_disagreement(fn(probs_test), fn(probs_cal))
        raw_area = aurc(fn(probs_test), correct_test)
        cal_area = aurc(fn(probs_cal), correct_test)
        print(
            f"  {name:<12}  disagreement {rate:.4f}"
            f"   aurc {raw_area:.4f} -> {cal_area:.4f}"
        )
    lm_rate = pair_disagreement(logit_margin(logits_test), logit_margin(logits_cal))
    print(
        f"  logit margin  disagreement {lm_rate:.4f}"
        f"   (temperature-invariant by construction)"
    )

    print("\n== 4. the same signals on shifted traffic ==")
    logits_shift = model.logits(x_shift)
    probs_shift = softmax(logits_shift)
    correct_shift = predictions(probs_shift) == y_shift
    print(
        f"shifted accuracy {accuracy(probs_shift, y_shift):.3f}"
        f" -> full-coverage risk {1.0 - accuracy(probs_shift, y_shift):.3f}"
    )
    print_risk_table(probs_shift, correct_shift, "shifted")
    print_budget_row(probs_shift, correct_shift)

    print("\n== 5. where max softmax and margin part ways ==")
    msp = max_softmax(probs_test)
    mgn = margin(probs_test)
    rank_msp = np.empty(N_TEST, dtype=np.int64)
    rank_msp[np.lexsort((np.arange(N_TEST), -msp))] = np.arange(N_TEST)
    rank_mgn = np.empty(N_TEST, dtype=np.int64)
    rank_mgn[np.lexsort((np.arange(N_TEST), -mgn))] = np.arange(N_TEST)
    item = int(np.abs(rank_msp - rank_mgn).argmax())
    row = np.sort(probs_test[item])[::-1]
    print(
        f"largest rank split: item {item}, msp rank {rank_msp[item]}"
        f" vs margin rank {rank_mgn[item]} of {N_TEST}"
    )
    print(
        "its sorted probability row: "
        + ", ".join(f"{p:.3f}" for p in row)
    )
    print(
        "max softmax reads only the first number; margin also reads the"
        " second,\nso rows that spread the leftover mass thin rank higher"
        " under margin than\nrows with one strong runner-up"
    )


if __name__ == "__main__":
    main()
