import pytest

from multihop.data import Query
from multihop.evaluate import (
    Aggregate,
    aggregate,
    bridge_accuracy,
    drift_split,
    run_all,
    score,
    single_hop,
    two_hop,
)
from multihop.pipeline import Retrieval

TWO_HOP = Query(
    id="q1",
    question="which cluster backs billing",
    kind="two-hop",
    answer_id="infra",
    hop1_id="resp",
    bridge=("wobble",),
)
SINGLE_HOP = Query(
    id="q2", question="where does wobble store data", kind="single-hop", answer_id="infra"
)


def retrieval(ranking: list[str], hop1: list[str], bridge: list[str]) -> Retrieval:
    return Retrieval(
        ranking=ranking,
        hop1_ranking=hop1,
        hop2_ranking=[],
        bridge_terms=bridge,
        search_calls=2,
    )


def test_score_rr_and_hits() -> None:
    result = score(TWO_HOP, retrieval(["resp", "infra"], ["resp"], ["wobble"]))
    assert result.rr == 0.5
    assert not result.hit1
    assert result.hit5
    assert result.pair5 is True
    assert result.hop1_top1_correct is True
    assert result.bridge_hit is True


def test_score_answer_missing_from_ranking() -> None:
    result = score(TWO_HOP, retrieval(["resp", "other"], ["resp"], ["wrong"]))
    assert result.rr == 0.0
    assert result.pair5 is False
    assert result.bridge_hit is False


def test_score_answer_past_rr_cutoff_counts_zero() -> None:
    ranking = [f"d{i}" for i in range(10)] + ["infra"]
    result = score(TWO_HOP, retrieval(ranking, ["resp"], ["wobble"]))
    assert result.rr == 0.0


def test_score_pair_needs_both_docs_in_top5() -> None:
    ranking = ["infra", "x1", "x2", "x3", "resp"]
    assert score(TWO_HOP, retrieval(ranking, ["resp"], ["wobble"])).pair5 is True
    ranking = ["infra", "x1", "x2", "x3", "x4", "resp"]
    assert score(TWO_HOP, retrieval(ranking, ["resp"], ["wobble"])).pair5 is False


def test_score_single_hop_has_no_pair_or_bridge_fields() -> None:
    result = score(SINGLE_HOP, retrieval(["infra"], ["infra"], []))
    assert result.rr == 1.0
    assert result.pair5 is None
    assert result.hop1_top1_correct is None
    assert result.bridge_hit is None


def test_score_empty_ranking() -> None:
    result = score(TWO_HOP, retrieval([], [], []))
    assert result.rr == 0.0
    assert not result.hit1
    assert result.pair5 is False
    assert result.hop1_top1_correct is False


def test_bridge_hit_requires_every_gold_token() -> None:
    query = Query(
        id="q3",
        question="q",
        kind="two-hop",
        answer_id="infra",
        hop1_id="resp",
        bridge=("alpha", "beta"),
    )
    partial = score(query, retrieval(["infra"], ["resp"], ["alpha", "extra"]))
    assert partial.bridge_hit is False
    full = score(query, retrieval(["infra"], ["resp"], ["beta", "alpha", "extra"]))
    assert full.bridge_hit is True


def test_aggregate_means() -> None:
    results = [
        score(TWO_HOP, retrieval(["infra", "resp"], ["resp"], ["wobble"])),
        score(TWO_HOP, retrieval(["resp", "infra"], ["resp"], ["wobble"])),
    ]
    agg = aggregate(results)
    assert agg == Aggregate(
        n=2, recall1=0.5, recall5=1.0, mrr=0.75, pair5=1.0, search_calls=2.0
    )


def test_aggregate_empty_raises() -> None:
    with pytest.raises(ValueError):
        aggregate([])


def test_drift_split_three_buckets() -> None:
    gold = score(TWO_HOP, retrieval(["resp", "infra"], ["resp"], ["wobble"]))
    leak = score(TWO_HOP, retrieval(["infra"], ["infra"], ["wobble"]))
    drift = score(TWO_HOP, retrieval(["junk"], ["junk"], ["junk"]))
    split = drift_split([gold, leak, drift])
    assert split["hop1 top-1 gold"] == (1, 0.5)
    assert split["hop1 top-1 answer (leak)"] == (1, 1.0)
    assert split["hop1 top-1 other (drift)"] == (1, 0.0)


def test_bridge_accuracy_ignores_missing_bridges() -> None:
    hit = score(TWO_HOP, retrieval(["infra"], ["resp"], ["wobble"]))
    miss = score(TWO_HOP, retrieval(["infra"], ["resp"], ["junk"]))
    no_terms = score(TWO_HOP, retrieval([], [], []))
    assert bridge_accuracy([hit, miss, no_terms]) == 0.5


def test_bridge_accuracy_empty_raises() -> None:
    with pytest.raises(ValueError):
        bridge_accuracy([score(SINGLE_HOP, retrieval(["infra"], ["infra"], []))])


def test_run_all_shapes() -> None:
    docs = {
        "resp": "wobble wobble owns billing",
        "infra": "wobble stores records in the maindb cluster",
        "noise": "unrelated cluster words",
    }
    results = run_all(docs, [TWO_HOP, SINGLE_HOP], top_k=3)
    assert {len(results[name]) for name in ("single", "iter-append", "iter-focus")} == {2}
    assert len(results["oracle"]) == 1  # oracle only exists for two-hop queries
    assert len(two_hop(results["single"])) == 1
    assert len(single_hop(results["single"])) == 1
    for name in ("iter-append", "iter-focus", "oracle"):
        assert all(r.retrieval.search_calls == 2 for r in two_hop(results[name]))
