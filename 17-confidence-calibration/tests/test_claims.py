"""The training-curve claims, checked against the curve itself.

Section 1 is the only place the project draws a shape rather than a
number, and the shape is easy to overstate: the guo et al result is
"accuracy plateaus while calibration rots", and it is tempting to
narrate this curve that way. On this data accuracy does not plateau,
it slides, and validation ece dips before it climbs. These tests
recompute the printed curve and then hold the readme and the entry
point's own section heading to what it actually shows.
"""

import importlib.util
import re
from pathlib import Path

import pytest

from calibration.data import LABELS, generate_tickets, labels_array
from calibration.features import build_vocabulary, vectorize
from calibration.metrics import accuracy, ece, softmax
from calibration.model import SoftmaxRegression

_ROOT = Path(__file__).resolve().parents[1]


def _load_entry_point():
    # load by path: sibling projects on sys.path also have a main.py
    path = _ROOT / "main.py"
    spec = importlib.util.spec_from_file_location("calibration_main", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def entry_point():
    return _load_entry_point()


@pytest.fixture(scope="module")
def what_happens() -> str:
    """Just the '## what happens' section. The '## fixes' log quotes the
    wording these tests forbid, on purpose — it is the record of the
    claim being removed, not the claim."""
    readme = (_ROOT / "README.md").read_text(encoding="utf-8")
    sections = re.split(r"^## ", readme, flags=re.MULTILINE)
    return next(s for s in sections if s.startswith("what happens"))


@pytest.fixture(scope="module")
def curve(entry_point):
    """Validation accuracy and ece at exactly the checkpoints main.py
    prints, from exactly the run main.py does."""
    m = entry_point
    train = generate_tickets(m.N_TRAIN, seed=101, ambiguity=m.AMBIGUITY)
    val = generate_tickets(m.N_VAL, seed=202, ambiguity=m.AMBIGUITY)
    vocabulary = build_vocabulary([t.text for t in train])
    x_train = vectorize([t.text for t in train], vocabulary)
    x_val = vectorize([t.text for t in val], vocabulary)
    y_train, y_val = labels_array(train), labels_array(val)
    model = SoftmaxRegression(len(vocabulary), len(LABELS))
    rows, done = [], 0
    for point in m.CHECKPOINTS:
        model.fit(x_train, y_train, epochs=point - done, lr=m.LR, l2=m.L2)
        done = point
        probs = softmax(model.logits(x_val))
        rows.append(
            (point, accuracy(probs, y_val), ece(probs, y_val, m.BINS))
        )
    return rows


def test_validation_accuracy_slides_across_the_printed_curve(curve):
    """Not a plateau. The last printed checkpoint is materially worse
    than the first, so "accuracy is done moving" is false here."""
    first, last = curve[0][1], curve[-1][1]
    assert last < first - 0.04, f"{first:.3f} -> {last:.3f}"


def test_validation_accuracy_never_recovers_after_its_peak(curve):
    """It slides monotonically from the first checkpoint, so there is no
    reading of the curve on which accuracy has settled."""
    accuracies = [acc for _, acc, _ in curve]
    assert accuracies == sorted(accuracies, reverse=True)


def test_validation_ece_dips_before_it_climbs(curve):
    """Ece is not monotone over the printed checkpoints: it improves at
    least once before it starts rotting."""
    eces = [e for _, _, e in curve]
    assert any(b < a for a, b in zip(eces, eces[1:])), eces
    assert eces[-1] > min(eces)


def test_readme_does_not_claim_accuracy_stops_moving(what_happens):
    lowered = what_happens.lower()
    for phrase in ("done moving", "accuracy converges", "stopped learning"):
        assert phrase not in lowered, phrase


def test_readme_does_not_claim_ece_climbs_throughout(what_happens):
    assert "climbs the whole time" not in what_happens.lower()


def test_readme_quotes_both_ends_of_the_accuracy_slide(what_happens, curve):
    """The readme must show the accuracy slide, not just its far end:
    both the first and the last printed checkpoint value."""
    first, last = f"{curve[0][1]:.3f}", f"{curve[-1][1]:.3f}"
    for value in (first, last):
        assert value in what_happens, value


def test_entry_point_heading_matches_the_curve(entry_point, capsys):
    entry_point.main()
    out = capsys.readouterr().out
    heading = next(
        line for line in out.splitlines() if re.match(r"== 1\.", line.strip())
    )
    assert "converges" not in heading.lower(), heading


@pytest.fixture(scope="module")
def ledger_row() -> str:
    """The COMPLETED row for 17 in the repo ledger, one project up.

    The signals extension has its own row keyed by the same project
    name, so the match has to be exact up to the closing pipe."""
    ledger = (_ROOT.parent / "progress.md").read_text(encoding="utf-8")
    # the REVIEWED table keys its rows by project name too, so scope to the
    # COMPLETED section before matching or the date row comes back as well
    completed = ledger.split("## COMPLETED", 1)[1].split("\n## ", 1)[0]
    rows = [
        line
        for line in completed.splitlines()
        if line.startswith("| 17-confidence-calibration |")
    ]
    assert len(rows) == 1, "progress.md has no single COMPLETED row for 17"
    return rows[0]


class TestEpochHundredIsNotWhereTheCurveSettles:
    """The retired claim named epoch 100 specifically. These recompute
    the curve to refute that reading before the row is judged against
    it."""

    def test_accuracy_keeps_falling_well_past_epoch_100(self, curve):
        """"done moving at epoch 100" needs the checkpoint-100 value to
        be roughly where the curve ends. It is 4.6 points above it."""
        at_hundred = next(acc for point, acc, _ in curve if point == 100)
        assert at_hundred > curve[-1][1] + 0.04, f"{at_hundred:.3f}"

    def test_accuracy_has_already_fallen_by_epoch_100(self, curve):
        """And it is not the curve's start either, so quoting it as the
        settled value hides the slide on both sides."""
        at_hundred = next(acc for point, acc, _ in curve if point == 100)
        assert at_hundred < curve[0][1]

    def test_ece_at_epoch_100_is_the_dip_not_the_curves_start(self, curve):
        """So an ece span opening at the epoch-100 value starts mid-curve
        and drops the dip the readme names."""
        eces = {point: e for point, _, e in curve}
        assert eces[100] == min(eces.values())
        assert eces[100] < eces[curve[0][0]]


class TestLedgerRow:
    """progress.md is the summary the next project reads before reusing a
    mechanism, so it has to retract alongside the readme."""

    def test_ledger_has_exactly_one_completed_row_for_17(self, ledger_row):
        assert ledger_row.endswith("|")

    def test_ledger_row_does_not_claim_accuracy_stops_moving(self, ledger_row):
        lowered = ledger_row.lower()
        for phrase in (
            "done moving",
            "accuracy converges",
            "accuracy is done",
            "stopped learning",
        ):
            assert phrase not in lowered, phrase

    def test_ledger_row_does_not_quote_the_retired_epoch_100_pair(
        self, ledger_row, curve
    ):
        """0.818 is the epoch-100 accuracy. It was the whole evidence for
        "done moving" and it appears nowhere in the readme."""
        at_hundred = next(acc for point, acc, _ in curve if point == 100)
        assert f"{at_hundred:.3f}" not in ledger_row

    def test_ledger_row_quotes_both_ends_of_the_accuracy_slide(
        self, ledger_row, curve
    ):
        """Read off the curve rather than pasted: the first and last
        printed checkpoint, which is the slide the project does show."""
        for value in (f"{curve[0][1]:.3f}", f"{curve[-1][1]:.3f}"):
            assert value in ledger_row, value

    def test_ledger_row_carries_the_ece_dip(self, ledger_row, curve):
        """The ece span has to open at the curve's start, not at the dip,
        or the row reads as a climb the whole way."""
        eces = [e for _, _, e in curve]
        for value in (f"{eces[0]:.3f}", f"{min(eces):.3f}", f"{eces[-1]:.3f}"):
            assert value in ledger_row, value

    def test_ledger_row_says_both_numbers_pay(self, ledger_row):
        """The point of the 2026-08-31 retraction: this curve is not
        "overfitting costs calibration only"."""
        assert "both pay" in ledger_row.lower()
