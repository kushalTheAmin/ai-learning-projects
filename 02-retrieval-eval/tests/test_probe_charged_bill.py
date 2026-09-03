"""The postings bill charged for probes as well as scored postings.

`% of bill` counts only the postings a pruner actually scored. A probe is
a binary search that lands on one posting and reads it, so the honest
comparison against term-at-a-time is scored + probes. On common-heavy
traffic the pruners probe about as many postings as they score, which
takes most of the saving back — the readme used to claim the opposite.
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


# ---------------------------------------------------------------- the metric


def test_probe_charged_share_is_scored_plus_probes_over_the_bill():
    index, sampler = small_index()
    queries = generate_queries(20, seed=QUERY_SEED, stratum="typical", sampler=sampler)
    bill = measure(index, "taat", queries, 10).scored_mean
    for method in ("maxscore", "wand"):
        work = measure(index, method, queries, 10)
        assert probe_charged_share(work, bill) == (
            work.scored_mean + work.probes_mean
        ) / bill


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
        # bill, maxscore scored, maxscore probes, % of bill, +probes,
        # wand scored, wand probes, % of bill, +probes
        assert len(numbers) == 9, f"{stratum}: {numbers}"


def test_readme_probe_charged_percents_match_the_readme_table():
    """Each `+probes` cell is its own row's scored + probes over the bill.

    The printed counts are means rounded to integers, so reconstructing a
    percentage from them carries up to half a posting of slack on each of
    the three, which only matters where the bill is tiny (rare-only, 77).
    The tolerance is that slack and nothing more — a swapped column or a
    flipped sign is tens of points out and still caught.
    """
    for stratum, n in readme_strata_rows().items():
        bill, ms_scored, ms_probes, _, ms_charged = n[:5]
        wand_scored, wand_probes, _, wand_charged = n[5:]
        tolerance = 100 * 1.5 / bill + 0.05
        assert abs(ms_charged - 100 * (ms_scored + ms_probes) / bill) <= tolerance, stratum
        assert (
            abs(wand_charged - 100 * (wand_scored + wand_probes) / bill) <= tolerance
        ), stratum


def test_readme_does_not_claim_the_common_heavy_skip_survives_the_probes():
    """The old claim: `the skip stays above 60% and 80%`.

    Charging probes, the common-heavy skip is 37.9% (maxscore) and 37.0%
    (wand) — the 60-odd percent figure is the share of the bill the
    pruners still *touch*, quoted with the sign flipped.
    """
    text = normalized_readme()
    assert "the skip stays above 60% and 80%" not in text


def test_readme_quotes_the_probe_charged_skip_the_table_supports():
    """Every skip figure in the prose is 100% minus its own table cell."""
    rows = readme_strata_rows()
    text = normalized_readme()
    for stratum, method_index in (("typical", (4, 8)), ("common-heavy", (4, 8))):
        for column in method_index:
            charged = rows[stratum][column]
            skip = f"{100 - charged:.1f}%"
            assert skip in text, f"{stratum} skip {skip} is not stated in the readme"


def test_readme_states_the_common_heavy_skip_collapses():
    text = normalized_readme()
    assert "37.9% and 37.0%" in text
    assert "81.9% of the bill still skipped by maxscore and 80.0% by wand" in text
