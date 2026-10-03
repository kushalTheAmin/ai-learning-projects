"""The published summary, held to what the sweep prints today.

The 2026-09-02 fix changed what `rate` means. The sweep used to draw an
independent coin per query, so the column labelled 0.10 fired whatever 40
draws gave (7 queries, 17.5%); it now fires exactly round(rate * n). Rate
0.10 moved 0.866/0.822 -> 0.919/0.897 in that commit, and the conclusion
moved with it: replace no longer loses to the raw query at 10%, it clears
it by 0.067.

The readme was retracted then. The COMPLETED row in the repo ledger was
not, and kept publishing both retired numbers plus the reversed reading
("replace-mode already loses to the raw query") for a month. That row is
the summary the next project reads before reusing a mechanism, so these
tests hold it to the entry point's own numbers, recomputed here rather
than pasted, and hold it off the claims the sweep contradicts.

Same shape as 23's row on 2026-10-02 and 21's on 2026-10-02.
"""

import re
from pathlib import Path

import pytest

from query_rewriting.data import load_corpus, load_hypotheticals, load_queries
from query_rewriting.evaluate import aggregate, run_hyde, run_raw
from query_rewriting.generator import ScriptedHyde
from query_rewriting.reuse import BM25Index

_ROOT = Path(__file__).resolve().parents[1]
_SEED = 7


@pytest.fixture(scope="module")
def sweep():
    """mrr per mode at every published rate, plus raw, from the library."""
    docs = load_corpus()
    queries = load_queries()
    hypotheticals = load_hypotheticals()
    index = BM25Index(docs)
    rates = {}
    for rate in (0.0, 0.1, 0.25, 0.5, 1.0):
        hyde = ScriptedHyde(hypotheticals, hallucination_rate=rate, seed=_SEED)
        rates[rate] = {
            mode: aggregate(run_hyde(index, queries, hyde, mode)).mrr
            for mode in ("append", "replace")
        }
    return {"raw": aggregate(run_raw(index, queries)).mrr, "rates": rates}


@pytest.fixture(scope="module")
def ledger_row() -> str:
    """The COMPLETED row for 25 in the repo ledger, one project up."""
    ledger = (_ROOT.parent / "progress.md").read_text(encoding="utf-8")
    # the REVIEWED table keys its rows by project name too, so scope to the
    # COMPLETED section before matching or the date row comes back as well
    completed = ledger.split("## COMPLETED", 1)[1].split("\n## ", 1)[0]
    rows = [
        line
        for line in completed.splitlines()
        if line.startswith("| 25-query-rewriting |")
    ]
    assert len(rows) == 1, "progress.md has no single COMPLETED row for 25"
    return rows[0]


class TestSweepOrderingAtTenPercent:
    """What the rate-0.10 row actually says, so the row above can be judged."""

    def test_both_modes_clear_raw_at_ten_percent(self, sweep):
        """The reversal: neither mode loses to the raw query at 10%."""
        row = sweep["rates"][0.1]
        assert row["append"] == pytest.approx(0.919, abs=5e-4)
        assert row["replace"] == pytest.approx(0.897, abs=5e-4)
        assert sweep["raw"] == pytest.approx(0.830, abs=5e-4)
        assert row["replace"] > sweep["raw"]
        assert row["append"] > sweep["raw"]

    def test_the_retired_pair_reproduces_at_no_published_rate(self, sweep):
        """0.866 and 0.822 are the nominal-rate numbers. Nothing prints them."""
        for row in sweep["rates"].values():
            for mode in ("append", "replace"):
                assert row[mode] != pytest.approx(0.866, abs=5e-4)
                assert row[mode] != pytest.approx(0.822, abs=5e-4)

    def test_the_full_hallucination_half_still_holds(self, sweep):
        """0.367 vs 0.057 was right in the row and stays right."""
        row = sweep["rates"][1.0]
        assert row["append"] == pytest.approx(0.367, abs=5e-4)
        assert row["replace"] == pytest.approx(0.057, abs=5e-4)
        assert row["append"] > sweep["raw"] * 0.0  # anchor keeps votes
        assert row["replace"] < row["append"]

    def test_the_modes_only_pull_apart_above_ten_percent(self, sweep):
        """Where the anchor earns its keep, which is what the row should say."""
        gaps = {
            rate: row["append"] - row["replace"]
            for rate, row in sweep["rates"].items()
        }
        assert gaps[0.0] == pytest.approx(0.002, abs=5e-4)
        assert gaps[0.1] == pytest.approx(0.023, abs=5e-4)
        assert gaps[1.0] == pytest.approx(0.310, abs=5e-4)
        assert gaps[0.0] < gaps[0.1] < gaps[0.25] < gaps[0.5] < gaps[1.0]


class TestLedgerRow:
    """progress.md has to retract alongside the readme."""

    def test_ledger_has_exactly_one_completed_row_for_25(self, ledger_row):
        assert ledger_row.startswith("| 25-query-rewriting |")

    def test_row_does_not_publish_the_retired_rate_pair(self, ledger_row):
        """Both numbers the 2026-09-02 fix moved."""
        assert "0.822" not in ledger_row
        assert "0.866" not in ledger_row

    def test_row_does_not_publish_the_reversed_conclusion(self, ledger_row):
        """replace clears raw at 10% by 0.067; the row said it loses."""
        squashed = re.sub(r"\s+", " ", ledger_row)
        assert "already loses to the raw query" not in squashed
        assert "replace-mode already loses" not in squashed

    def test_row_quotes_the_rate_pair_the_run_prints(self, sweep, ledger_row):
        """Read off the run, so the row cannot drift from the table again."""
        row = sweep["rates"][0.1]
        assert f"{row['append']:.3f}" in ledger_row
        assert f"{row['replace']:.3f}" in ledger_row
        assert f"{sweep['raw']:.3f}" in ledger_row

    def test_row_says_both_modes_clear_raw_at_ten_percent(self, ledger_row):
        squashed = re.sub(r"\s+", " ", ledger_row)
        assert "both still clear the raw query" in squashed

    def test_row_keeps_the_full_hallucination_numbers(self, sweep, ledger_row):
        row = sweep["rates"][1.0]
        assert f"{row['append']:.3f}" in ledger_row
        assert f"{row['replace']:.3f}" in ledger_row

    def test_row_does_not_publish_a_single_crossing_bracket(self, ledger_row):
        """The 2026-10-03 fix retired append's 22.5-25% for a ten-point band."""
        assert "22.5% and 25%" not in ledger_row
        assert "22.5-25%" not in ledger_row
