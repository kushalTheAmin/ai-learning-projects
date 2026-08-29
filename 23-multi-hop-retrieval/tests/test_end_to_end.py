"""Full path over the committed dataset: the numbers the README quotes
come from exactly this pipeline, so these assertions bind the headline
claims rather than restating unit behavior."""

from multihop.data import load_corpus, load_queries, validate
from multihop.evaluate import aggregate, bridge_accuracy, drift_split, run_all, single_hop, two_hop
from multihop.reuse import paired_bootstrap


def build_results():
    docs = load_corpus()
    queries = load_queries()
    validate(docs, queries)
    return run_all(docs, queries)


def test_iterative_beats_single_shot_on_two_hop() -> None:
    results = build_results()
    single = aggregate(two_hop(results["single"]))
    append = aggregate(two_hop(results["iter-append"]))
    assert append.recall5 > single.recall5
    assert append.mrr > single.mrr
    assert append.pair5 is not None and single.pair5 is not None
    assert append.pair5 > single.pair5


def test_bootstrap_gap_excludes_zero() -> None:
    results = build_results()
    single_rr = [r.rr for r in two_hop(results["single"])]
    append_rr = [r.rr for r in two_hop(results["iter-append"])]
    comparison = paired_bootstrap(append_rr, single_rr)
    assert comparison.diff > 0
    assert comparison.ci.lo > 0


def test_oracle_bounds_extracted_bridge() -> None:
    results = build_results()
    oracle = aggregate(results["oracle"])
    append = aggregate(two_hop(results["iter-append"]))
    assert oracle.mrr >= append.mrr


def test_bridge_extraction_mostly_finds_gold() -> None:
    results = build_results()
    assert bridge_accuracy(results["iter-append"]) >= 0.9


def test_single_hop_controls_not_damaged() -> None:
    results = build_results()
    single = aggregate(single_hop(results["single"]))
    append = aggregate(single_hop(results["iter-append"]))
    assert append.mrr >= single.mrr - 1e-9
    assert append.search_calls == 2.0
    assert single.search_calls == 1.0


def test_drift_buckets_cover_all_two_hop_queries() -> None:
    results = build_results()
    split = drift_split(results["iter-append"])
    assert sum(count for count, _ in split.values()) == 24


def test_all_metrics_bounded() -> None:
    results = build_results()
    for name, rows in results.items():
        for r in rows:
            assert 0.0 <= r.rr <= 1.0, (name, r.query.id)
            ranking = r.retrieval.ranking
            assert len(ranking) == len(set(ranking)), "combined ranking has duplicates"


def test_deterministic_across_runs() -> None:
    first = build_results()
    second = build_results()
    for name in first:
        assert [r.rr for r in first[name]] == [r.rr for r in second[name]]
        assert [r.retrieval.ranking for r in first[name]] == [
            r.retrieval.ranking for r in second[name]
        ]
