"""Where the RRF lead actually comes from.

The README's third headline bullet credited RRF's overall MRR@10 and recall@1
lead to recovering BM25's paraphrase misses. BM25 misses exactly one query
past the cutoff and RRF does not recover it; the lead comes from RRF keeping
each retriever's sole rank-1 instead. These pin the measurement, prove its
zero is not vacuous, and hold the README to the measured reading.
"""

import re
import subprocess
import sys
from pathlib import Path

import pytest

from hybrid_search.evaluate import (
    MRR_K,
    QueryResult,
    aggregate,
    evaluate,
    fusion_attribution,
    load_json,
)
from hybrid_search.metrics import reciprocal_rank

PROJECT_DIR = Path(__file__).parent.parent
DATA_DIR = PROJECT_DIR / "data"
README = PROJECT_DIR / "README.md"


@pytest.fixture(scope="module")
def results():
    return evaluate(load_json(DATA_DIR / "corpus.json"), load_json(DATA_DIR / "queries.json"))


@pytest.fixture(scope="module")
def attribution(results):
    return fusion_attribution(results)


def _first_rank(ranking, relevant):
    for position, doc_id in enumerate(ranking, start=1):
        if doc_id in relevant:
            return position
    return None


def test_bm25_misses_one_query_and_rrf_recovers_none(attribution):
    # the retired claim was "it recovers several of bm25s paraphrase misses"
    assert attribution["bm25"]["missed"] == ["p14"]
    assert attribution["bm25"]["missed_recovered"] == []


def test_the_one_miss_stays_a_miss_at_its_measured_ranks(results):
    p14 = next(r for r in results if r.query_id == "p14")
    assert _first_rank(p14.rankings["bm25"], p14.relevant) == 12
    assert _first_rank(p14.rankings["hybrid_rrf"], p14.relevant) == 11
    assert reciprocal_rank(p14.rankings["hybrid_rrf"], p14.relevant, MRR_K) == 0.0


def test_every_query_rrf_improves_over_bm25_was_already_a_hit(results):
    moved = [
        r
        for r in results
        if _first_rank(r.rankings["hybrid_rrf"], r.relevant)
        < _first_rank(r.rankings["bm25"], r.relevant)
    ]
    assert [r.query_id for r in moved] == ["p01", "p02", "p09", "p14"]
    scored = [r for r in moved if reciprocal_rank(r.rankings["hybrid_rrf"], r.relevant, MRR_K) > 0]
    assert [r.query_id for r in scored] == ["p01", "p02", "p09"]
    for r in scored:
        assert reciprocal_rank(r.rankings["bm25"], r.relevant, MRR_K) > 0, r.query_id


def test_dense_misses_nothing_at_the_cutoff(attribution):
    assert attribution["dense"]["missed"] == []


def test_rrf_keeps_both_retrievers_sole_rank_one(attribution):
    # the mechanism the lead actually rests on
    assert attribution["bm25"]["sole_first"] == ["p08"]
    assert attribution["dense"]["sole_first"] == ["p01"]
    assert attribution["bm25"]["sole_first_kept"] == ["p08"]
    assert attribution["dense"]["sole_first_kept"] == ["p01"]


def test_the_two_sole_rank_ones_are_the_whole_recall_at_1_gain(results, attribution):
    table = aggregate(results)
    sole = attribution["bm25"]["sole_first"] + attribution["dense"]["sole_first"]
    assert len(sole) == 2
    # each single retriever owns one of the two and forfeits the other, rrf
    # holds both: one query of the 40, and recall@1 counts p13's two relevant
    # docs as a half, so the gap is exactly 1/40
    assert table["hybrid_rrf"]["recall@1"] - table["bm25"]["recall@1"] == pytest.approx(1 / 40)
    assert table["hybrid_rrf"]["recall@1"] - table["dense"]["recall@1"] == pytest.approx(1 / 40)


def test_the_mrr_lead_over_dense_is_one_query_against_three_losses(results):
    deltas = {}
    for r in results:
        dense = reciprocal_rank(r.rankings["dense"], r.relevant, MRR_K)
        rrf = reciprocal_rank(r.rankings["hybrid_rrf"], r.relevant, MRR_K)
        if dense != rrf:
            deltas[r.query_id] = rrf - dense
    assert sorted(deltas) == ["p02", "p08", "p09", "p14"]
    assert [q for q, d in deltas.items() if d > 0] == ["p08"]
    assert deltas["p08"] == pytest.approx(0.5)
    table = aggregate(results)
    assert sum(deltas.values()) / len(results) == pytest.approx(
        table["hybrid_rrf"]["mrr"] - table["dense"]["mrr"]
    )


def test_the_recovery_counter_can_fire(results):
    # a 0 that cannot be anything else measures nothing: hand the audit a
    # ranking where the fusion does pull a miss inside the cutoff
    ranking = [f"d{i}" for i in range(20)]
    recovered = ranking[MRR_K:] + ranking[:MRR_K]
    one = QueryResult(
        query_id="q",
        category="keyword",
        relevant={"d19"},
        rankings={"bm25": ranking, "dense": ranking, "hybrid_rrf": recovered},
    )
    report = fusion_attribution([one])
    assert report["bm25"]["missed"] == ["q"]
    assert report["bm25"]["missed_recovered"] == ["q"]


def test_the_sole_rank_one_counter_needs_the_other_side_to_lose_it():
    # a query both retrievers put first is nobody's sole rank-1
    shared = [f"d{i}" for i in range(5)]
    both = QueryResult(
        query_id="q",
        category="keyword",
        relevant={"d0"},
        rankings={"bm25": shared, "dense": shared, "hybrid_rrf": shared},
    )
    report = fusion_attribution([both])
    assert report["bm25"]["sole_first"] == []
    assert report["dense"]["sole_first"] == []


def test_entry_point_prints_the_attribution():
    proc = subprocess.run(
        [sys.executable, str(PROJECT_DIR / "main.py")],
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert proc.returncode == 0, proc.stderr
    assert "WHERE THE RRF LEAD COMES FROM" in proc.stdout
    assert re.search(r"bm25\s+misses 1 query at the cutoff \(p14\), rrf recovers 0", proc.stdout)
    assert re.search(r"ranks the answer first alone on 1 \(p08\), rrf keeps 1", proc.stdout)
    assert re.search(r"dense\s+misses 0 queries at the cutoff", proc.stdout)


def _numbers_prose() -> str:
    text = README.read_text(encoding="utf-8")
    after_fence = text.split("## the numbers", 1)[1].split("```")[2]
    return " ".join(after_fence.split("\n## ", 1)[0].split())


def test_readme_no_longer_credits_the_lead_to_a_recovered_miss():
    prose = _numbers_prose()
    assert "recovers several" not in prose
    assert "not by rescuing a miss" in prose


def test_readme_states_the_measured_mechanism():
    prose = _numbers_prose()
    for token in ("p14", "p08", "p01", "0.838"):
        assert token in prose, token
