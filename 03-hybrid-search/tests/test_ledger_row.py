"""The repo ledger's COMPLETED row for 03, held to what the run prints.

The row in ../progress.md is the summary another project reads before
reusing a mechanism from here, and it carries measured figures: the three
paraphrase mrr@10 values, the overall rrf mrr, and the claim that keyword
queries are saturated for every strategy. Nothing bound those to the
harness, so the 2026-08-27 stemmer fix moved paraphrase dense mrr 0.794 to
0.793 in the readme and left the ledger quoting the pre-fix value.

Same class 23, 21, 18 and 17 each grew for the same drift: the readme gets
fixed, the index does not. These read the row and recompute every number in
it from `aggregate`, so the row cannot be typed stale again.
"""

import re
from pathlib import Path

import pytest

from hybrid_search.evaluate import aggregate, evaluate, load_json

PROJECT_DIR = Path(__file__).parent.parent
DATA_DIR = PROJECT_DIR / "data"
LEDGER = PROJECT_DIR.parent / "progress.md"


@pytest.fixture(scope="module")
def results():
    corpus = load_json(DATA_DIR / "corpus.json")
    queries = load_json(DATA_DIR / "queries.json")
    return evaluate(corpus, queries)


@pytest.fixture(scope="module")
def ledger_row() -> str:
    """The one COMPLETED row for 03, one directory up."""
    text = LEDGER.read_text(encoding="utf-8")
    # the REVIEWED table keys its rows by project name too, so scope to the
    # COMPLETED section first or that date row comes back as a second match
    completed = text.split("## COMPLETED", 1)[1].split("\n## ", 1)[0]
    rows = [
        line
        for line in completed.splitlines()
        if line.startswith("| 03-hybrid-search |")
    ]
    assert len(rows) == 1, "progress.md has no single COMPLETED row for 03"
    return rows[0]


class TestLedgerRow:
    def test_ledger_has_exactly_one_completed_row_for_03(self, ledger_row):
        assert ledger_row.startswith("| 03-hybrid-search |")

    def test_row_quotes_the_paraphrase_mrrs_the_run_computes(
        self, results, ledger_row
    ):
        """The three figures the stemmer fix moved out from under."""
        table = aggregate(results, category="paraphrase")
        bm25 = f"{table['bm25']['mrr']:.3f}"
        dense = f"{table['dense']['mrr']:.3f}"
        rrf = f"{table['hybrid_rrf']['mrr']:.3f}"
        assert (bm25, dense, rrf) == ("0.765", "0.793", "0.799")
        assert (
            f"paraphrase mrr@10: bm25 {bm25}, dense {dense}, hybrid rrf {rrf}"
            in ledger_row
        )

    def test_row_does_not_carry_the_pre_stemmer_fix_dense_mrr(self, ledger_row):
        """0.794 is the retired reading, and 0.793 is not a prefix of it."""
        quoted = re.findall(r"dense (\d\.\d{3})", ledger_row)
        assert quoted == ["0.793"]

    def test_row_quotes_the_overall_rrf_mrr_the_run_computes(
        self, results, ledger_row
    ):
        overall = aggregate(results)
        rrf = f"{overall['hybrid_rrf']['mrr']:.3f}"
        assert rrf == "0.899"
        assert f"overall rrf best at {rrf}" in ledger_row

    def test_the_overall_rrf_mrr_is_actually_the_best_of_the_four(self, results):
        """"best" is the part of that clause aggregate has to agree with."""
        overall = aggregate(results)
        best = max(overall, key=lambda name: overall[name]["mrr"])
        assert best == "hybrid_rrf"

    def test_row_claims_keyword_saturation_only_while_it_holds(
        self, results, ledger_row
    ):
        keyword = aggregate(results, category="keyword")
        assert all(
            value == 1.0 for row in keyword.values() for value in row.values()
        )
        assert "keyword saturated for both" in ledger_row
