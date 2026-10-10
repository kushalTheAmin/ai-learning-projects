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
from multihop.evaluate import (
    PAIR_K,
    aggregate,
    compare_rr,
    run_all,
    two_hop,
    two_hop_rr,
)
from multihop.pipeline import iterative
from multihop.reuse import BM25Index

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
def ledger_row() -> str:
    """The COMPLETED row for 23 in the repo ledger, one project up."""
    ledger = (_ROOT.parent / "progress.md").read_text(encoding="utf-8")
    # the REVIEWED table keys its rows by project name too, so scope to the
    # COMPLETED section before matching or the date row comes back as well
    completed = ledger.split("## COMPLETED", 1)[1].split("\n## ", 1)[0]
    rows = [
        line
        for line in completed.splitlines()
        if line.startswith("| 23-multi-hop-retrieval |")
    ]
    assert len(rows) == 1, "progress.md has no single COMPLETED row for 23"
    return rows[0]


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


class TestOracleGap:
    """Where the oracle's +0.011 over iter-append actually comes from.

    The readme read the gap off bridge coverage: 0.958, so extraction is
    nearly free, and the one coverage miss is t01. Both halves are true
    and neither explains the gap. t01 contributes exactly 0.000 to it —
    append mode keeps the question, so the hop-2 ranking is identical
    whether the extractor pulls `ledgerd` or `autovacuum`. The whole
    +0.011 is t16 and t22, two queries where extraction *did* cover the
    gold bridge and the two padding terms `max_terms=3` bolted on next to
    it pulled a distractor over the answer doc.
    """

    def _deltas(self, results):
        oracle = results["oracle"]
        append = two_hop(results["iter-append"])
        assert [o.query.id for o in oracle] == [a.query.id for a in append]
        return {
            o.query.id: round(o.rr - a.rr, 4)
            for o, a in zip(oracle, append)
            if abs(o.rr - a.rr) > 1e-12
        }

    def test_the_gap_is_t16_and_t22_and_nothing_else(self, results):
        assert self._deltas(results) == {"t16": 0.1333, "t22": 0.1333}

    def test_the_coverage_miss_costs_exactly_nothing(self, results):
        """t01 is the only gold-bridge miss and the oracle gains 0.000 on it."""
        misses = [
            r.query.id
            for r in two_hop(results["iter-append"])
            if r.bridge_hit is False
        ]
        assert misses == ["t01"]
        assert "t01" not in self._deltas(results)

    def test_the_two_queries_that_move_covered_the_gold_bridge(self, results):
        """So the gap is not a coverage failure; the extractor found the bridge."""
        by_id = {r.query.id: r for r in two_hop(results["iter-append"])}
        for query_id in ("t16", "t22"):
            assert by_id[query_id].bridge_hit is True
            assert "chirpline" in by_id[query_id].retrieval.bridge_terms
            assert len(by_id[query_id].retrieval.bridge_terms) == 3

    def test_padding_terms_are_the_mechanism_not_coverage(self, results):
        """Same hop-1 doc, same gold bridge, only the padding differs.

        Feeding `iterative` the extractor's own three terms reproduces
        append's rank-5 answer; dropping the two padding terms and keeping
        the bridge reproduces the oracle's rank 3. Nothing else changes.
        """
        docs = load_corpus()
        index = BM25Index(docs)
        queries = {q.id: q for q in load_queries()}
        by_id = {r.query.id: r for r in two_hop(results["iter-append"])}
        for query_id, padded in (
            ("t16", ["chirpline", "alerts", "delivery"]),
            ("t22", ["sms", "chirpline", "alerts"]),
        ):
            question = queries[query_id].question
            assert by_id[query_id].retrieval.bridge_terms == padded
            with_padding = iterative(
                index, docs, question, mode="append", bridge_override=padded
            )
            bridge_only = iterative(
                index, docs, question, mode="append", bridge_override=["chirpline"]
            )
            answer = queries[query_id].answer_id
            assert with_padding.ranking.index(answer) == 4
            assert bridge_only.ranking.index(answer) == 2

    def test_oracle_never_loses_a_resample(self, results):
        """Not the two-sided straddle the focus gap is: it is bounded below by zero."""
        comparison = compare_rr(results, "oracle", "iter-append")
        assert comparison.p_ge_zero == 1.0
        assert comparison.ci.lo == 0.0


class TestReadmeOracleBullet:
    def test_does_not_blame_the_gap_on_coverage(self, readme):
        body = readme.split("## fixes", 1)[0]
        assert "so scripted extraction is nearly free" not in body

    def test_names_the_two_queries_the_gap_is_made_of(self, readme):
        body = readme.split("## fixes", 1)[0]
        assert "t16" in body
        assert "t22" in body

    def test_says_the_coverage_miss_costs_nothing(self, readme):
        body = readme.split("## fixes", 1)[0]
        assert "t01 costs nothing" in body

    def test_names_padding_as_the_price_of_extraction(self, readme):
        body = readme.split("## fixes", 1)[0]
        assert "max_terms" in body


class TestLedgerRow:
    """progress.md has to retract alongside the readme.

    The 2026-09-01 fix pulled "iter-focus beats iter-append" out of the
    readme because the gap is +0.010 [-0.011, +0.032], 4 of 24 queries move
    and t10 moves the other way. The COMPLETED row in the repo ledger kept
    asserting it as a measured finding with a mechanism on it — "focus beats
    append because question terms re-admit distractors" — and that row is the
    summary the next project reads before reusing a mechanism. Same shape as
    the 14 finding of 2026-08-30: the readme got fixed, the index did not.
    """

    def _recall5(self, results, name: str) -> str:
        rows = results[name] if name == "oracle" else two_hop(results[name])
        return f"{aggregate(rows).recall5:.3f}"

    def test_ledger_has_exactly_one_completed_row_for_23(self, ledger_row):
        assert ledger_row.startswith("| 23-multi-hop-retrieval |")

    def test_row_does_not_publish_the_focus_ordering_as_a_result(self, ledger_row):
        """The retired claim, and the mechanism that was hung on it."""
        assert "focus beats append" not in ledger_row
        assert "re-admit" not in ledger_row

    def test_row_carries_the_focus_gap_with_its_interval(self, results, ledger_row):
        comparison = compare_rr(results, "iter-focus", "iter-append")
        interval = (
            f"{comparison.diff:+.3f} "
            f"[{comparison.ci.lo:+.3f}, {comparison.ci.hi:+.3f}]"
        )
        assert interval in ledger_row

    def test_row_says_how_wide_the_focus_gap_is_and_which_way_it_points(
        self, results, ledger_row
    ):
        """4 of 24 and t10 are what make the ordering unpublishable."""
        append = two_hop(results["iter-append"])
        focus = two_hop(results["iter-focus"])
        moved = {
            a.query.id: f.rr - a.rr
            for a, f in zip(append, focus)
            if abs(f.rr - a.rr) > 1e-12
        }
        against = [qid for qid, delta in moved.items() if delta < 0.0]
        assert f"{len(moved)} of {len(append)}" in ledger_row
        assert against == ["t10"]
        assert "t10" in ledger_row

    def test_row_names_the_one_query_behind_the_recall_headline(
        self, results, ledger_row
    ):
        """The 1.000 against append's 0.958 is t03 and nothing else."""
        append = two_hop(results["iter-append"])
        focus = two_hop(results["iter-focus"])
        differing = [a.query.id for a, f in zip(append, focus) if a.hit5 != f.hit5]
        assert differing == ["t03"]
        assert "t03" in ledger_row

    def test_row_quotes_the_recall_figures_the_run_prints(self, results, ledger_row):
        """Read off the run, so the row cannot drift from the table."""
        single = self._recall5(results, "single")
        append = self._recall5(results, "iter-append")
        focus = self._recall5(results, "iter-focus")
        assert (single, append, focus) == ("0.667", "0.958", "1.000")
        assert f"{single} single vs {append} append and {focus} focus" in ledger_row


class TestPairMetricIsNotASecondSignal:
    """pair@5 cannot disagree with recall@5 on this corpus.

    `pair5` wants both gold docs inside the consumed top 5. The capability
    doc — hop 1's gold doc — lands at rank 1 or 2 for every query under
    every system, so the pair criterion can only ever fail on the answer
    doc, and the column comes out equal to recall@5 in all four rows. The
    readme read the two as a metric and a stricter metric agreeing.
    """

    SYSTEMS = ("single", "iter-append", "iter-focus", "oracle")

    def _rows(self, results, name):
        return results[name] if name == "oracle" else two_hop(results[name])

    def _worst_hop1_rank(self, results) -> int:
        worst = 0
        for name in self.SYSTEMS:
            for r in self._rows(results, name):
                ranking = r.retrieval.ranking
                assert r.query.hop1_id in ranking, (name, r.query.id)
                worst = max(worst, ranking.index(r.query.hop1_id) + 1)
        return worst

    def test_pair5_equals_recall5_in_every_published_row(self, results):
        for name in self.SYSTEMS:
            agg = aggregate(self._rows(results, name))
            assert agg.pair5 is not None
            assert agg.pair5 == pytest.approx(agg.recall5, abs=1e-12), name

    def test_pair5_agrees_with_hit5_query_by_query(self, results):
        for name in self.SYSTEMS:
            disagreeing = [
                r.query.id for r in self._rows(results, name) if r.pair5 != r.hit5
            ]
            assert disagreeing == [], name

    def test_the_hop1_doc_never_leaves_the_consumed_top_two(self, results):
        """The mechanism: nothing here can push the capability doc past 5."""
        worst = self._worst_hop1_rank(results)
        assert worst == 2
        assert worst < PAIR_K


class TestReadmePairMetric:
    def test_does_not_read_pair5_as_a_second_metric_agreeing(self, readme):
        body = readme.split("## fixes", 1)[0]
        assert "moves the same way" not in body
        assert "which is what a reader needs to actually justify the answer" not in body

    def test_says_the_column_duplicates_recall5(self, readme):
        body = readme.split("## fixes", 1)[0]
        assert "the column is recall@5 copied" in body

    def test_names_the_rank_that_makes_it_degenerate(self, results, readme):
        """Read off the run, so the prose cannot drift from the table."""
        worst = TestPairMetricIsNotASecondSignal()._worst_hop1_rank(results)
        n = len(two_hop(results["single"]))
        body = readme.split("## fixes", 1)[0]
        assert f"rank 1 or {worst} on all {n} queries" in body
