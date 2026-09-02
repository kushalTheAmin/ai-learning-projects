"""The hallucination sweep, held to the rate on its own x-axis.

Each query drew an independent coin against the rate, so the column labelled
`rate` was a nominal probability and the sweep measured whatever the 40 draws
happened to give: 0.10 fired 7 of 40 (17.5%), 0.50 fired 15 (37.5%). The
readme then read its conclusion off the label rather than the draw — "at a
10% hallucination rate replace is already below the raw query, one wrong
answer in ten erases the entire benefit" — and at a real 10% replace scores
0.897, well above raw's 0.830. 17.5% is exactly where it crosses.

The draw is now the rate-quantile of the same fixed per-query scores, so
`round(rate * n)` queries hallucinate exactly, the sets stay nested across
rates, and every point on the curve sits at the rate it is labelled with.

These tests hold the realized rate to the nominal one, hold the two crossing
points to a bracket, hold the entry point to printing a count that matches
its own rate column, and hold the readme to the corrected numbers.
"""

import importlib.util
import io
import re
from contextlib import redirect_stdout
from pathlib import Path

import pytest

from query_rewriting.data import load_corpus, load_hypotheticals, load_queries
from query_rewriting.evaluate import aggregate, run_hyde, run_raw
from query_rewriting.generator import ScriptedHyde
from query_rewriting.reuse import BM25Index

_ROOT = Path(__file__).resolve().parents[1]

SWEEP_RATES = (0.0, 0.1, 0.25, 0.5, 1.0)


def _load_entry_point():
    # load by path: sibling projects on sys.path also have a main.py
    path = _ROOT / "main.py"
    spec = importlib.util.spec_from_file_location("query_rewriting_main", path)
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
def setup():
    docs = load_corpus()
    queries = load_queries()
    hypotheticals = load_hypotheticals()
    return docs, queries, hypotheticals, BM25Index(docs)


@pytest.fixture(scope="module")
def bank():
    return load_hypotheticals()


@pytest.fixture(scope="module")
def raw_mrr(setup):
    _, queries, _, index = setup
    return aggregate(run_raw(index, queries)).mrr


@pytest.fixture(scope="module")
def readme() -> str:
    return _squash((_ROOT / "README.md").read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def printed() -> str:
    buffer = io.StringIO()
    with redirect_stdout(buffer):
        _load_entry_point().main()
    return buffer.getvalue()


def _fired(bank, rate, seed=7):
    hyde = ScriptedHyde(bank, hallucination_rate=rate, seed=seed)
    return {query_id for query_id in bank if hyde.generate(query_id).hallucinated}


def _mrr(setup, rate, mode, seed=7):
    _, queries, hypotheticals, index = setup
    hyde = ScriptedHyde(hypotheticals, hallucination_rate=rate, seed=seed)
    return aggregate(run_hyde(index, queries, hyde, mode)).mrr


class TestRealizedRateMatchesTheLabel:
    @pytest.mark.parametrize("rate", SWEEP_RATES)
    def test_every_swept_rate_fires_its_nominal_count(self, bank, rate):
        assert len(_fired(bank, rate)) == round(rate * len(bank))

    @pytest.mark.parametrize("seed", [0, 1, 7, 13, 21])
    def test_the_count_is_exact_for_any_seed(self, bank, seed):
        # the old draw was 7/40 at seed 7 and 12/40 at seed 21; the rate a
        # reader sees must not depend on which seed the run happened to use
        for rate in SWEEP_RATES:
            assert len(_fired(bank, rate, seed=seed)) == round(rate * len(bank))

    def test_the_seed_still_chooses_which_queries_fire(self, bank):
        assert _fired(bank, 0.25, seed=0) != _fired(bank, 0.25, seed=1)

    def test_sets_stay_nested_at_single_query_granularity(self, bank):
        previous: set[str] = set()
        for count in range(len(bank) + 1):
            current = _fired(bank, count / len(bank))
            assert previous <= current
            assert len(current) == count
            previous = current

    def test_endpoints_are_none_and_all(self, bank):
        assert _fired(bank, 0.0) == set()
        assert _fired(bank, 1.0) == set(bank)

    def test_half_a_query_rounds_up(self):
        # 3 queries at 0.5 is 1.5; round-half-up gives 2, and banker's
        # rounding would silently give 1
        odd = {"q1": "answer one", "q2": "answer two", "q3": "answer three"}
        assert len(_fired(odd, 0.5)) == 2

    def test_generation_is_still_deterministic(self, bank):
        a = ScriptedHyde(bank, hallucination_rate=0.25, seed=7)
        b = ScriptedHyde(bank, hallucination_rate=0.25, seed=7)
        assert [a.generate(q) for q in sorted(bank)] == [b.generate(q) for q in sorted(bank)]


class TestPublishedSweep:
    def test_ten_percent_is_survivable_by_both_modes(self, setup, raw_mrr):
        # the claim the readme had backwards: at a real 10% neither mode is
        # below raw, and replace has 0.067 of headroom left
        assert _mrr(setup, 0.1, "append") > raw_mrr
        assert _mrr(setup, 0.1, "replace") > raw_mrr

    def test_replace_crosses_under_raw_between_15_and_17_5_percent(self, setup, raw_mrr):
        assert _mrr(setup, 6 / 40, "replace") > raw_mrr
        assert _mrr(setup, 7 / 40, "replace") < raw_mrr

    def test_append_crosses_under_raw_between_22_5_and_25_percent(self, setup, raw_mrr):
        assert _mrr(setup, 9 / 40, "append") > raw_mrr
        assert _mrr(setup, 10 / 40, "append") < raw_mrr

    def test_append_outlives_replace_at_every_rate(self, setup):
        for rate in SWEEP_RATES[1:]:
            assert _mrr(setup, rate, "append") > _mrr(setup, rate, "replace")

    @pytest.mark.parametrize(
        "rate,append,replace",
        [
            (0.0, 0.983, 0.981),
            (0.1, 0.919, 0.897),
            (0.25, 0.818, 0.747),
            (0.5, 0.652, 0.509),
            (1.0, 0.367, 0.057),
        ],
    )
    def test_sweep_table_is_pinned(self, setup, rate, append, replace):
        assert _mrr(setup, rate, "append") == pytest.approx(append, abs=0.0005)
        assert _mrr(setup, rate, "replace") == pytest.approx(replace, abs=0.0005)


class TestEntryPoint:
    def test_prints_a_count_that_matches_its_own_rate_column(self, printed):
        rows = re.findall(r"^\s*(\d\.\d\d)\s+(\d+)\s+\d\.\d\d\d", printed, re.MULTILINE)
        assert [rate for rate, _ in rows] == ["0.00", "0.10", "0.25", "0.50", "1.00"]
        for rate, n_halluc in rows:
            assert int(n_halluc) == round(float(rate) * 40)


class TestReadme:
    def test_does_not_claim_one_in_ten_erases_the_benefit(self, readme):
        body = readme.split("## fixes", 1)[0]
        assert "one wrong answer in ten" not in body

    def test_does_not_put_replace_below_raw_at_ten_percent(self, readme):
        body = readme.split("## fixes", 1)[0]
        assert "0.822 vs 0.830" not in body

    def test_carries_the_corrected_sweep_rows(self, readme):
        for value in ("0.919", "0.897", "0.652", "0.509"):
            assert value in readme

    def test_names_both_crossing_brackets(self, readme):
        body = readme.split("## fixes", 1)[0]
        assert "15% and 17.5%" in body
        assert "22.5% and 25%" in body
