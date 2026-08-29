import pytest

from query_rewriting.data import Query
from query_rewriting.evaluate import (
    aggregate,
    by_category,
    paired_rrs,
    run_generic_append,
    run_hyde,
    run_prf,
    run_raw,
)
from query_rewriting.generator import ScriptedHyde
from query_rewriting.reuse import BM25Index

DOCS = {
    "a": "alpha beta",
    "b": "alpha gamma gamma",
    "c": "delta epsilon",
}


@pytest.fixture()
def index() -> BM25Index:
    return BM25Index(DOCS)


def test_raw_scores_a_direct_hit(index):
    queries = [Query("q1", "alpha", ("a",), "keyword")]
    outcome = run_raw(index, queries)[0]
    # "alpha" matches a and b; a is shorter so length normalization ranks it first
    assert outcome.rr == 1.0
    assert outcome.recall1 == 1.0
    assert outcome.recall5 == 1.0
    assert outcome.added_terms == 0


def test_raw_scores_a_miss_as_zero(index):
    queries = [Query("q1", "gamma", ("a",), "keyword")]
    outcome = run_raw(index, queries)[0]
    assert outcome.rr == 0.0
    assert outcome.recall5 == 0.0


def test_hyde_append_can_flip_a_ranking(index):
    # raw "alpha" ranks a over b; an answer containing gamma flips it to b
    queries = [Query("q1", "alpha", ("b",), "keyword")]
    assert run_raw(index, queries)[0].rr == 0.5
    hyde = ScriptedHyde({"q1": "gamma gamma", "q2": "unused"}, hallucination_rate=0.0)
    appended = run_hyde(index, queries, hyde, "append")[0]
    assert appended.rr == 1.0
    assert appended.added_terms == 1
    assert appended.hallucinated is False


def test_hyde_replace_loses_the_query_anchor(index):
    # the hypothetical says only "delta", so replace can no longer find b
    queries = [Query("q1", "alpha", ("b",), "keyword")]
    hyde = ScriptedHyde({"q1": "delta", "q2": "unused"}, hallucination_rate=0.0)
    replaced = run_hyde(index, queries, hyde, "replace")[0]
    assert replaced.rr == 0.0
    appended = run_hyde(index, queries, hyde, "append")[0]
    # append keeps b findable; the rare "delta" also pulls c up, so b sits third
    assert appended.rr == pytest.approx(1 / 3)


def test_run_hyde_rejects_unknown_mode(index):
    hyde = ScriptedHyde({"q1": "x", "q2": "y"}, hallucination_rate=0.0)
    with pytest.raises(ValueError, match="mode"):
        run_hyde(index, [], hyde, "prepend")


def test_prf_records_whether_the_expansion_doc_was_gold(index):
    queries = [
        Query("q1", "beta", ("a",), "keyword"),  # top doc a is gold
        Query("q2", "gamma", ("a",), "keyword"),  # top doc b is not
        Query("q3", "unseen", ("a",), "keyword"),  # no top doc at all
    ]
    outcomes = run_prf(DOCS, index, queries, max_terms=2)
    assert outcomes[0].prf_source_relevant is True
    assert outcomes[1].prf_source_relevant is False
    assert outcomes[2].prf_source_relevant is None


def test_generic_append_adds_the_same_filler_everywhere(index):
    queries = [
        Query("q1", "alpha", ("a",), "keyword"),
        Query("q2", "delta", ("c",), "paraphrase"),
    ]
    outcomes = run_generic_append(index, queries)
    assert outcomes[0].added_terms == outcomes[1].added_terms
    assert outcomes[0].added_terms > 10


def test_aggregate_means_the_fields():
    queries = [
        Query("q1", "alpha", ("a",), "keyword"),
        Query("q2", "gamma", ("a",), "paraphrase"),
    ]
    index = BM25Index(DOCS)
    agg = aggregate(run_raw(index, queries))
    assert agg.n == 2
    assert agg.mrr == 0.5
    assert agg.recall1 == 0.5
    assert agg.added_terms == 0.0


def test_aggregate_refuses_empty_outcomes():
    with pytest.raises(ValueError, match="zero query outcomes"):
        aggregate([])


def test_by_category_splits(index):
    queries = [
        Query("q1", "alpha", ("a",), "keyword"),
        Query("q2", "gamma", ("b",), "paraphrase"),
    ]
    outcomes = run_raw(index, queries)
    assert [o.query_id for o in by_category(outcomes, "keyword")] == ["q1"]
    assert [o.query_id for o in by_category(outcomes, "paraphrase")] == ["q2"]


def test_paired_rrs_aligns_by_query_id(index):
    queries = [
        Query("q1", "alpha", ("a",), "keyword"),
        Query("q2", "gamma", ("b",), "paraphrase"),
    ]
    forward = run_raw(index, queries)
    backward = run_raw(index, list(reversed(queries)))
    rrs_a, rrs_b = paired_rrs(forward, backward)
    assert rrs_a == rrs_b


def test_paired_rrs_rejects_mismatched_query_sets(index):
    outcomes = run_raw(index, [Query("q1", "alpha", ("a",), "keyword")])
    other = run_raw(index, [Query("q2", "alpha", ("a",), "keyword")])
    with pytest.raises(ValueError, match="same query set"):
        paired_rrs(outcomes, other)


def test_unicode_and_empty_queries_survive(index):
    queries = [
        Query("q1", "naïve café résumé", ("a",), "keyword"),
        Query("q2", "", ("a",), "keyword"),  # loader forbids this; scoring must not crash
    ]
    outcomes = run_raw(index, queries)
    assert [o.rr for o in outcomes] == [0.0, 0.0]
