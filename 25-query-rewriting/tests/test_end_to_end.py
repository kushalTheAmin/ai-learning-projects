import pytest

from query_rewriting.data import load_corpus, load_hypotheticals, load_queries, validate
from query_rewriting.evaluate import (
    aggregate,
    by_category,
    run_generic_append,
    run_hyde,
    run_prf,
    run_raw,
)
from query_rewriting.generator import ScriptedHyde
from query_rewriting.reuse import BM25Index


@pytest.fixture(scope="module")
def setup():
    docs = load_corpus()
    queries = load_queries()
    hypotheticals = load_hypotheticals()
    validate(docs, queries, hypotheticals)
    return docs, queries, hypotheticals, BM25Index(docs)


def test_headline_numbers_are_pinned(setup):
    docs, queries, hypotheticals, index = setup
    honest = ScriptedHyde(hypotheticals, hallucination_rate=0.0, seed=7)
    raw_mrr = aggregate(run_raw(index, queries)).mrr
    append_mrr = aggregate(run_hyde(index, queries, honest, "append")).mrr
    assert raw_mrr == pytest.approx(0.830, abs=0.0005)
    assert append_mrr == pytest.approx(0.983, abs=0.0005)


def test_honest_hyde_beats_raw_and_generic_filler_loses(setup):
    docs, queries, hypotheticals, index = setup
    honest = ScriptedHyde(hypotheticals, hallucination_rate=0.0, seed=7)
    raw_mrr = aggregate(run_raw(index, queries)).mrr
    assert aggregate(run_hyde(index, queries, honest, "append")).mrr > raw_mrr
    assert aggregate(run_hyde(index, queries, honest, "replace")).mrr > raw_mrr
    assert aggregate(run_generic_append(index, queries)).mrr < raw_mrr


def test_full_hallucination_craters_below_raw(setup):
    docs, queries, hypotheticals, index = setup
    wrong = ScriptedHyde(hypotheticals, hallucination_rate=1.0, seed=7)
    raw_mrr = aggregate(run_raw(index, queries)).mrr
    append_mrr = aggregate(run_hyde(index, queries, wrong, "append")).mrr
    replace_mrr = aggregate(run_hyde(index, queries, wrong, "replace")).mrr
    assert append_mrr < raw_mrr
    assert replace_mrr < append_mrr  # the raw query terms are the anchor


def test_hyde_rescues_the_out_of_vocabulary_acronym(setup):
    # k14 asks for "GIL"; the corpus only ever spells the term out, so raw
    # search matches nothing and the spelled-out hypothetical is the bridge
    docs, queries, hypotheticals, index = setup
    honest = ScriptedHyde(hypotheticals, hallucination_rate=0.0, seed=7)
    raw_by_id = {o.query_id: o for o in run_raw(index, queries)}
    hyde_by_id = {o.query_id: o for o in run_hyde(index, queries, honest, "append")}
    assert raw_by_id["k14"].rr == 0.0
    assert hyde_by_id["k14"].rr == 1.0


def test_paraphrase_gap_is_where_rewriting_acts(setup):
    docs, queries, hypotheticals, index = setup
    honest = ScriptedHyde(hypotheticals, hallucination_rate=0.0, seed=7)
    raw_outcomes = run_raw(index, queries)
    hyde_outcomes = run_hyde(index, queries, honest, "append")
    raw_gap = (
        aggregate(by_category(raw_outcomes, "keyword")).mrr
        - aggregate(by_category(raw_outcomes, "paraphrase")).mrr
    )
    hyde_gap = (
        aggregate(by_category(hyde_outcomes, "keyword")).mrr
        - aggregate(by_category(hyde_outcomes, "paraphrase")).mrr
    )
    assert raw_gap > 0.1
    assert hyde_gap < raw_gap / 2


def test_prf_only_rewrites_when_the_first_search_matched(setup):
    docs, queries, hypotheticals, index = setup
    outcomes = run_prf(docs, index, queries, max_terms=5)
    unexpanded = [o for o in outcomes if o.prf_source_relevant is None]
    assert [o.query_id for o in unexpanded] == ["k14"]
    assert all(o.added_terms == 0 for o in unexpanded)
    assert all(o.added_terms <= 5 for o in outcomes)


def test_whole_pipeline_is_deterministic(setup):
    docs, queries, hypotheticals, index = setup

    def one_run():
        hyde = ScriptedHyde(hypotheticals, hallucination_rate=0.25, seed=7)
        return (
            run_raw(index, queries),
            run_prf(docs, index, queries, max_terms=5),
            run_hyde(index, queries, hyde, "append"),
            run_hyde(index, queries, hyde, "replace"),
        )

    assert one_run() == one_run()
