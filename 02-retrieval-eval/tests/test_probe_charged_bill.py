"""The postings bill charged for probes as well as scored postings.

`% of bill` counts only the postings a pruner actually scored. A probe is
a binary search that lands on one posting and reads it, so that posting
belongs in the honest comparison against term-at-a-time — but only once.
Most of a pruner's probes find the posting they then score, so adding the
two counts bills it twice; the `read` column counts each posting once.
"""

import re
from pathlib import Path

from pruning import (
    N_STRATUM_QUERIES,
    QUERY_SEED,
    METHODS,
    measure,
    print_strata,
    probe_charged_share,
)
from retrieval_eval.pruned import PrunedBM25Index
from retrieval_eval.synth import ZipfSampler, generate_corpus, generate_queries

README = Path(__file__).resolve().parent.parent / "README.md"

STRATA = ("typical", "common-heavy", "rare-only")


def normalized_readme() -> str:
    """Readme as one whitespace-collapsed line, so a wrap cannot hide a claim."""
    return " ".join(README.read_text(encoding="utf-8").split())


def small_index(vocab_size: int = 3_000, n_docs: int = 600, seed: int = 7):
    sampler = ZipfSampler(vocab_size=vocab_size)
    return PrunedBM25Index(generate_corpus(n_docs, seed, sampler)), sampler


# ------------------------------------------------- the probe is not a free read


def double_charge_corpus() -> dict[str, str]:
    """Six docs, hand traced below, where one probe finds what it scores.

    `the` is in every doc so its bound is tiny, `cat` is in two so its
    bound is large. At top-1, once d2 takes the lead, `the` drops out of
    the essential set, and scoring d5 probes `the`'s list, lands on d5's
    own posting, and scores it. That posting is read once.
    """
    return {f"d{i}": ("the cat" if i in (2, 5) else "the dog") for i in range(6)}


def test_a_probe_that_finds_its_posting_is_not_a_second_posting():
    index = PrunedBM25Index(double_charge_corpus())
    _, taat = index.search_with_stats("cat the", 1)
    assert taat.postings_touched == 8  # df 2 for cat + df 6 for the
    for stats in (
        index.search_maxscore_with_stats("cat the", 1)[1],
        index.search_wand_with_stats("cat the", 1)[1],
    ):
        assert stats.postings_scored == 6
        assert stats.probes == 1
        # the one probe lands on the posting scored at d5, so the search
        # reads six postings, not the seven scored + probes would bill
        assert stats.postings_read == 6


def test_postings_read_is_bracketed_by_scored_and_scored_plus_probes():
    index, sampler = small_index()
    for stratum in STRATA:
        queries = generate_queries(20, seed=QUERY_SEED, stratum=stratum, sampler=sampler)
        for query in queries:
            for stats in (
                index.search_maxscore_with_stats(query, 10)[1],
                index.search_wand_with_stats(query, 10)[1],
            ):
                assert stats.postings_scored <= stats.postings_read
                assert stats.postings_read <= stats.postings_scored + stats.probes


def test_the_double_charge_is_material_on_common_heavy_traffic():
    """Not a corner case: most of a pruner's probes find what they score."""
    index, sampler = small_index()
    queries = generate_queries(
        20, seed=QUERY_SEED, stratum="common-heavy", sampler=sampler
    )
    for method in ("maxscore", "wand"):
        work = measure(index, method, queries, 10)
        naive = work.scored_mean + work.probes_mean
        assert work.read_mean < 0.8 * naive, method


def test_probe_charged_share_counts_each_posting_once():
    index, sampler = small_index()
    queries = generate_queries(20, seed=QUERY_SEED, stratum="typical", sampler=sampler)
    bill = measure(index, "taat", queries, 10).scored_mean
    for method in ("maxscore", "wand"):
        work = measure(index, method, queries, 10)
        assert probe_charged_share(work, bill) == work.read_mean / bill
        assert probe_charged_share(work, bill) < (
            work.scored_mean + work.probes_mean
        ) / bill


# ---------------------------------------------------------------- the metric


def test_probe_charged_share_is_never_below_the_scored_share():
    index, sampler = small_index()
    for stratum in STRATA:
        queries = generate_queries(20, seed=QUERY_SEED, stratum=stratum, sampler=sampler)
        bill = measure(index, "taat", queries, 10).scored_mean
        if bill == 0:
            continue
        for method in ("maxscore", "wand"):
            work = measure(index, method, queries, 10)
            assert probe_charged_share(work, bill) >= work.scored_mean / bill


def test_probes_take_back_more_of_the_common_heavy_bill_than_the_typical_one():
    """The substance of the correction, measured rather than asserted.

    On typical traffic probes are a small tax on a large saving. On
    common-heavy traffic they are the same order as the postings scored,
    so charging them moves the number a lot further.
    """
    index, sampler = small_index()
    taken_back = {}
    for stratum in ("typical", "common-heavy"):
        queries = generate_queries(30, seed=QUERY_SEED, stratum=stratum, sampler=sampler)
        bill = measure(index, "taat", queries, 10).scored_mean
        work = measure(index, "maxscore", queries, 10)
        taken_back[stratum] = probe_charged_share(work, bill) - work.scored_mean / bill
    assert taken_back["common-heavy"] > taken_back["typical"]


# ------------------------------------------------------------- the entry point


def test_strata_table_prints_a_probe_charged_column(monkeypatch, capsys):
    index, sampler = small_index()
    monkeypatch.setattr("pruning.N_STRATUM_QUERIES", 15)
    print_strata(index, sampler)
    out = capsys.readouterr().out
    header = next(line for line in out.splitlines() if line.startswith("stratum"))
    assert header.count("+probes") == 2, "one probe-charged column per pruner"
    assert header.count("% of bill") == 2
    for stratum in STRATA:
        row = next(line for line in out.splitlines() if line.startswith(stratum))
        assert len(re.findall(r"\d+\.\d%", row)) == 4, row


def test_printed_probe_charged_column_matches_the_measured_share(monkeypatch, capsys):
    index, sampler = small_index()
    monkeypatch.setattr("pruning.N_STRATUM_QUERIES", 15)
    print_strata(index, sampler)
    out = capsys.readouterr().out
    for stratum in STRATA:
        queries = generate_queries(15, seed=QUERY_SEED + 1, stratum=stratum, sampler=sampler)
        work = {m: measure(index, m, queries, 10) for m in METHODS}
        bill = work["taat"].scored_mean
        row = next(line for line in out.splitlines() if line.startswith(stratum))
        percents = re.findall(r"(\d+\.\d)%", row)
        assert percents[1] == f"{100 * probe_charged_share(work['maxscore'], bill):.1f}"
        assert percents[3] == f"{100 * probe_charged_share(work['wand'], bill):.1f}"


# -------------------------------------------------------------------- the prose


def readme_strata_rows() -> dict[str, list[float]]:
    """The committed `postings scored per query` table, parsed back out."""
    block = re.search(
        r"== postings scored per query at 32,000 docs.*?```", README.read_text(), re.S
    )
    assert block, "the strata table is gone from the readme"
    rows = {}
    for line in block.group(0).splitlines():
        for stratum in STRATA:
            if line.startswith(stratum):
                rows[stratum] = [float(n) for n in re.findall(r"\d+(?:\.\d+)?", line)]
    assert set(rows) == set(STRATA), rows
    return rows


def test_readme_table_carries_the_probe_charged_column():
    rows = readme_strata_rows()
    for stratum, numbers in rows.items():
        # bill, maxscore scored, maxscore probes, maxscore read, % of bill,
        # +probes, then the same five for wand
        assert len(numbers) == 11, f"{stratum}: {numbers}"


def test_readme_probe_charged_percents_match_the_readme_table():
    """Each `+probes` cell is its own row's `read` over the bill.

    The printed counts are means rounded to integers, so reconstructing a
    percentage from them carries up to half a posting of slack on each of
    the two, which only matters where the bill is tiny (rare-only, 77).
    The tolerance is that slack and nothing more — a swapped column or a
    row still billing scored + probes is tens of points out and caught.
    """
    for stratum, n in readme_strata_rows().items():
        bill, ms_scored, ms_probes, ms_read, _, ms_charged = n[:6]
        wand_scored, wand_probes, wand_read, _, wand_charged = n[6:]
        tolerance = 100 * 1.0 / bill + 0.05
        assert abs(ms_charged - 100 * ms_read / bill) <= tolerance, stratum
        assert abs(wand_charged - 100 * wand_read / bill) <= tolerance, stratum
        # read sits between the scored count and the naive sum, and on the
        # head-term strata it is strictly under it — that is the correction
        assert ms_scored <= ms_read <= ms_scored + ms_probes, stratum
        assert wand_scored <= wand_read <= wand_scored + wand_probes, stratum
        if stratum != "rare-only":
            assert ms_read < ms_scored + ms_probes, stratum
            assert wand_read < wand_scored + wand_probes, stratum


def test_readme_does_not_claim_the_common_heavy_skip_survives_the_probes():
    """Two retired readings of this column, neither allowed back.

    `the skip stays above 60% and 80%` read the touched share as the skip.
    `37.9% and 37.0%` was the skip once probes were charged twice over.
    """
    text = normalized_readme()
    assert "the skip stays above 60% and 80%" not in text
    assert "takes most of the win back: 37.9% and 37.0%" not in text


def test_readme_quotes_the_probe_charged_skip_the_table_supports():
    """Every skip figure in the prose is 100% minus its own table cell."""
    rows = readme_strata_rows()
    text = normalized_readme()
    for stratum, method_index in (("typical", (5, 10)), ("common-heavy", (5, 10))):
        for column in method_index:
            charged = rows[stratum][column]
            skip = f"{100 - charged:.1f}%"
            assert skip in text, f"{stratum} skip {skip} is not stated in the readme"


def test_readme_states_the_common_heavy_skip_gives_back_a_chunk():
    text = normalized_readme()
    assert "gives back a real chunk: 63.0% and 55.3%" in text
    assert "88.0% of the bill still skipped by maxscore and 85.5% by wand" in text
