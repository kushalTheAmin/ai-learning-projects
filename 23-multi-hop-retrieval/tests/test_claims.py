"""The published comparisons, held to what a resample says about them.

The project runs a paired bootstrap on iter-append vs single and reports a
gap that clears zero comfortably. It then reads a second comparison —
iter-focus vs iter-append — straight off the means and published it as a
result, bolded, with a design lesson attached. That gap is +0.010 with a
95% interval of [-0.011, +0.032]: it does not clear zero, only 4 of the 24
queries move at all, and one of those moves the other way. The recall@5
difference behind the headline (0.958 vs 1.000) is exactly one query.

These tests hold every system-vs-system claim to an interval, hold the
entry point to printing them, and hold the readme to the difference between
"measured" and "within noise".
"""

import importlib.util
import io
import re
from contextlib import redirect_stdout
from pathlib import Path

import pytest

from multihop.data import load_corpus, load_queries
from multihop.evaluate import compare_rr, run_all, two_hop, two_hop_rr

_ROOT = Path(__file__).resolve().parents[1]


def _load_entry_point():
    # load by path: sibling projects on sys.path also have a main.py
    path = _ROOT / "main.py"
    spec = importlib.util.spec_from_file_location("multihop_main", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _squash(text: str) -> str:
    """Collapse newlines and runs of spaces.

    A banned phrase that wraps across a line in the readme never matches a
    naive `in` check, so the test passes on both versions and binds nothing.
    """
    return re.sub(r"\s+", " ", text)


@pytest.fixture(scope="module")
def results():
    docs = load_corpus()
    return run_all(docs, load_queries())


@pytest.fixture(scope="module")
def readme() -> str:
    return _squash((_ROOT / "README.md").read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def printed() -> str:
    buffer = io.StringIO()
    with redirect_stdout(buffer):
        _load_entry_point().main()
    return buffer.getvalue()


class TestPairedGaps:
    """Every gap the readme reasons from, recomputed with its interval."""

    def test_append_vs_single_clears_zero(self, results):
        """The comparison the project always bootstrapped. Still real."""
        comparison = compare_rr(results, "iter-append", "single")
        assert comparison.diff == pytest.approx(0.080, abs=5e-4)
        assert comparison.ci.lo == pytest.approx(0.043, abs=5e-4)
        assert comparison.ci.hi == pytest.approx(0.119, abs=5e-4)
        assert comparison.ci.lo > 0.0
        assert comparison.p_le_zero == 0.0

    def test_focus_vs_append_does_not_clear_zero(self, results):
        """The defect: this gap was published as a result without one."""
        comparison = compare_rr(results, "iter-focus", "iter-append")
        assert comparison.diff == pytest.approx(0.010, abs=5e-4)
        assert comparison.ci.lo == pytest.approx(-0.011, abs=5e-4)
        assert comparison.ci.hi == pytest.approx(0.032, abs=5e-4)
        assert comparison.ci.lo < 0.0 < comparison.ci.hi
        assert comparison.p_le_zero == pytest.approx(0.1895, abs=5e-5)

    def test_oracle_vs_append_does_not_clear_zero_either(self, results):
        """'oracle equals extracted almost everywhere' is the safe reading."""
        comparison = compare_rr(results, "oracle", "iter-append")
        assert comparison.diff == pytest.approx(0.011, abs=5e-4)
        assert comparison.ci.lo == pytest.approx(0.000, abs=5e-4)
        assert comparison.ci.hi == pytest.approx(0.028, abs=5e-4)
        assert not comparison.ci.lo > 0.0
        assert comparison.p_le_zero == pytest.approx(0.1275, abs=5e-5)

    def test_focus_beats_append_on_exactly_one_query_at_five(self, results):
        """The 0.958 -> 1.000 recall@5 headline is one query wide."""
        append = two_hop(results["iter-append"])
        focus = two_hop(results["iter-focus"])
        differing = [
            a.query.id for a, f in zip(append, focus) if a.hit5 != f.hit5
        ]
        assert differing == ["t03"]
        assert sum(f.hit5 for f in focus) == 24
        assert sum(a.hit5 for a in append) == 23

    def test_four_queries_move_and_one_moves_the_other_way(self, results):
        """A mean gap of +0.010 over 24 queries is 4 queries, not a trend."""
        append = two_hop(results["iter-append"])
        focus = two_hop(results["iter-focus"])
        moved = {
            a.query.id: round(f.rr - a.rr, 4)
            for a, f in zip(append, focus)
            if abs(f.rr - a.rr) > 1e-12
        }
        assert moved == {
            "t03": 0.1667,
            "t05": 0.0833,
            "t10": -0.1333,
            "t24": 0.1333,
        }
        assert moved["t10"] < 0.0


class TestPairing:
    def test_two_hop_rr_aligns_every_system_on_the_same_queries(self, results):
        ids = [two_hop_rr(results, name)[0] for name in
               ("single", "iter-append", "iter-focus", "oracle")]
        assert len(ids[0]) == 24
        assert all(other == ids[0] for other in ids[1:])

    def test_compare_rr_refuses_misaligned_samples(self, results):
        """A paired bootstrap over different queries is silently wrong."""
        trimmed = dict(results)
        trimmed["oracle"] = results["oracle"][:-1]
        with pytest.raises(ValueError, match="different queries"):
            compare_rr(trimmed, "oracle", "iter-append")


class TestEntryPoint:
    def test_prints_an_interval_for_every_published_gap(self, printed):
        for line in (
            "iter-append vs single",
            "iter-focus vs iter-append",
            "oracle vs iter-append",
        ):
            assert line in printed

    def test_prints_the_focus_gap_with_its_zero_crossing(self, printed):
        assert "+0.010 [-0.011, +0.032]" in printed

    def test_prints_the_append_gap_that_does_clear_zero(self, printed):
        assert "+0.080 [+0.043, +0.119]" in printed


class TestReadme:
    def test_does_not_call_the_focus_gap_measured(self, readme):
        body = readme.split("## fixes", 1)[0]
        assert "measurably hurt" not in body

    def test_does_not_publish_focus_beating_append_as_a_result(self, readme):
        body = readme.split("## fixes", 1)[0]
        assert "iter-focus beats iter-append" not in body

    def test_carries_the_focus_interval(self, readme):
        assert "+0.010 [-0.011, +0.032]" in readme

    def test_names_the_one_query_behind_the_recall_headline(self, readme):
        body = readme.split("## fixes", 1)[0]
        assert "4 of 24" in body
        assert "t10" in body
