"""The prf result, held to how few queries it is made of.

The readme read the prf section off two group means. "on the 7 queries where
the top doc was wrong it gained +0.044, because the wrong doc was usually
topic-adjacent (a git doc for a git question) and its distinctive terms still
vote for the right neighborhood" — `usually` is a claim about most of those 7,
and 5 of them moved by exactly 0.000. The whole +0.008 headline is two
queries: p02 and p03. The entry point printed the same two group means with no
count of what moved inside them, so the paragraph had nothing to contradict it.

Same shape as 23's pair@5 fix on 2026-10-10 and 01's call-overhead fix on
2026-10-11: a number that is real, read as a tendency the measurement does not
contain.

These tests compute the concentration off the real pipeline rather than
pasting it, hold the entry point to printing a moved count and every nonzero
delta, and hold the readme to reporting them.
"""

import importlib.util
import io
import re
from contextlib import redirect_stdout
from pathlib import Path

import pytest

from query_rewriting.data import load_corpus, load_hypotheticals, load_queries
from query_rewriting.evaluate import run_prf, run_raw
from query_rewriting.reuse import BM25Index, mean, paired_bootstrap

_ROOT = Path(__file__).resolve().parents[1]
MAX_TERMS = 5


def _squash(text: str) -> str:
    return re.sub(r"\s+", " ", text)


@pytest.fixture(scope="module")
def deltas():
    """Per-query prf-5 delta rr, with the expansion-source label."""
    docs = load_corpus()
    queries = load_queries()
    index = BM25Index(docs)
    raw_rr = {outcome.query_id: outcome.rr for outcome in run_raw(index, queries)}
    return {
        outcome.query_id: (
            outcome.prf_source_relevant,
            outcome.rr - raw_rr[outcome.query_id],
            raw_rr[outcome.query_id],
            outcome.rr,
        )
        for outcome in run_prf(docs, index, queries, max_terms=MAX_TERMS)
    }


@pytest.fixture(scope="module")
def readme() -> str:
    return _squash((_ROOT / "README.md").read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def printed() -> str:
    path = _ROOT / "main.py"
    spec = importlib.util.spec_from_file_location("query_rewriting_main_prf", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    buffer = io.StringIO()
    with redirect_stdout(buffer):
        module.main()
    return buffer.getvalue()


@pytest.fixture(scope="module")
def prf_block(printed) -> str:
    block = printed.split("prf-5 delta rr vs raw", 1)[1]
    return block.split("\nhallucination sweep", 1)[0]


class TestTheGainIsTwoQueries:
    def test_exactly_two_of_forty_queries_move_at_all(self, deltas):
        movers = {qid for qid, (_, delta, _, _) in deltas.items() if delta != 0.0}
        assert len(deltas) == 40
        assert movers == {"p02", "p03"}

    def test_both_movers_are_in_the_wrong_expansion_doc_group(self, deltas):
        for qid in ("p02", "p03"):
            assert deltas[qid][0] is False

    def test_p02_is_the_one_rescue_from_nothing(self, deltas):
        """gold absent from raw's top 10, pulled in at rank 7."""
        _, delta, raw_rr, prf_rr = deltas["p02"]
        assert raw_rr == 0.0
        assert prf_rr == pytest.approx(1 / 7)
        assert delta == pytest.approx(1 / 7)

    def test_p03_is_a_one_rank_nudge_not_a_rescue(self, deltas):
        """rank 3 to rank 2, so it was never a retrieval failure."""
        _, delta, raw_rr, prf_rr = deltas["p03"]
        assert raw_rr == pytest.approx(1 / 3)
        assert prf_rr == pytest.approx(1 / 2)
        assert delta == pytest.approx(1 / 6)

    def test_five_of_the_seven_wrong_doc_queries_moved_nothing(self, deltas):
        wrong = {qid: d for qid, (label, d, _, _) in deltas.items() if label is False}
        assert len(wrong) == 7
        still = sorted(qid for qid, d in wrong.items() if d == 0.0)
        assert still == ["k08", "p01", "p09", "p12", "p14"]

    def test_the_group_mean_is_those_two_spread_over_seven(self, deltas):
        wrong = [d for (label, d, _, _) in deltas.values() if label is False]
        assert mean(wrong) == pytest.approx(0.044, abs=5e-4)
        assert mean(wrong) == pytest.approx((1 / 7 + 1 / 6) / 7)

    def test_no_query_with_a_gold_expansion_doc_moved_either_way(self, deltas):
        gold = [d for (label, d, _, _) in deltas.values() if label is True]
        assert len(gold) == 32
        assert set(gold) == {0.0}

    def test_raw_leaves_three_queries_at_zero_and_prf_rescues_one(self, deltas):
        zeros = sorted(qid for qid, (_, _, raw_rr, _) in deltas.items() if raw_rr == 0.0)
        assert zeros == ["k14", "p02", "p09"]
        # k14 has no first results to expand from, p09's expansion doc did not help
        assert deltas["k14"][0] is None
        assert deltas["p09"][3] == 0.0
        assert deltas["p02"][3] > 0.0


class TestTheUncertaintyIsTheSameTwoQueries:
    def test_p_le_zero_is_the_chance_a_resample_draws_neither_mover(self, deltas):
        """0.1289 is 0.95 ** 40, not a near-miss on a real effect."""
        prf_rrs = [prf_rr for (_, _, _, prf_rr) in deltas.values()]
        raw_rrs = [raw_rr for (_, _, raw_rr, _) in deltas.values()]
        comparison = paired_bootstrap(prf_rrs, raw_rrs)
        assert comparison.diff == pytest.approx(0.008, abs=5e-4)
        assert comparison.p_le_zero == pytest.approx(0.95**40, abs=0.01)

    def test_the_ci_lower_bound_is_that_point_mass_not_a_negative_tail(self, deltas):
        """No query lost ground, so the bound cannot be below zero."""
        prf_rrs = [prf_rr for (_, _, _, prf_rr) in deltas.values()]
        raw_rrs = [raw_rr for (_, _, raw_rr, _) in deltas.values()]
        comparison = paired_bootstrap(prf_rrs, raw_rrs)
        assert comparison.ci.lo == 0.0
        assert min(delta for (_, delta, _, _) in deltas.values()) == 0.0


class TestEntryPointPublishesTheConcentration:
    def test_the_split_table_prints_a_moved_count_per_group(self, prf_block):
        rows = re.findall(r"n=(\d+)\s+moved (\d+)\s+mean delta rr", prf_block)
        assert [(n, moved) for n, moved in rows] == [
            ("32", "0"),
            ("7", "2"),
            ("1", "0"),
        ]

    def test_the_split_table_accounts_for_all_forty_queries(self, prf_block):
        counts = [int(n) for n in re.findall(r"n=(\d+)", prf_block)]
        assert sum(counts) == 40

    def test_every_nonzero_delta_is_named(self, prf_block):
        assert "2 of 40 queries" in _squash(prf_block)
        movers = re.findall(r"(p\d\d) rr 0\.\d\d\d -> 0\.\d\d\d", prf_block)
        assert movers == ["p02", "p03"]


class TestReadmeReportsTheConcentration:
    def test_the_group_mean_is_no_longer_read_as_a_tendency(self, readme):
        body = readme.split("## fixes", 1)[0]
        assert "the wrong doc was usually topic-adjacent" not in body

    def test_k14_is_not_called_the_one_query_prf_could_have_rescued(self, readme):
        body = readme.split("## fixes", 1)[0]
        assert "the one query prf could have rescued" not in body

    def test_the_two_movers_are_named(self, readme):
        body = readme.split("## fixes", 1)[0]
        assert "p02" in body
        assert "p03" in body
        assert "2 of 40" in body

    def test_the_five_untouched_queries_are_stated(self, readme):
        body = readme.split("## fixes", 1)[0]
        assert "5 of" in body or "five of" in body

    def test_the_p_value_is_explained_as_the_resample_missing_both(self, readme):
        body = readme.split("## fixes", 1)[0]
        assert "0.95" in body


class TestRepoIndexRowReportsTheConcentration:
    """The root index row is the summary the next project reads first.

    01's and 25's own history is the ledger row that kept publishing a retired
    reading for a month after the readme retracted it, so the row gets held to
    the same facts as the paragraph.
    """

    @pytest.fixture(scope="module")
    def index_row(self) -> str:
        index = (_ROOT.parent / "README.md").read_text(encoding="utf-8")
        rows = [
            line
            for line in index.splitlines()
            if line.startswith("| 25 |")
        ]
        assert len(rows) == 1, "root README has no single index row for 25"
        return _squash(rows[0])

    def test_the_row_does_not_read_the_ci_bound_as_a_near_miss(self, index_row):
        assert "CI touching zero" not in index_row

    def test_the_row_names_the_two_query_concentration(self, index_row):
        assert "2 of 40" in index_row
        assert "p02" in index_row
        assert "p03" in index_row

    def test_the_row_keeps_the_headline_it_had_right(self, index_row, deltas):
        prf_rrs = [prf_rr for (_, _, _, prf_rr) in deltas.values()]
        raw_rrs = [raw_rr for (_, _, raw_rr, _) in deltas.values()]
        comparison = paired_bootstrap(prf_rrs, raw_rrs)
        assert "PRF barely moves" in index_row
        assert f"{comparison.diff:+.3f}" in index_row
