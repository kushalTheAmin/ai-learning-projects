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
