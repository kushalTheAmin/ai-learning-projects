from scaling import (
    TOP_K,
    count_identical,
    head_term_share,
    query_work,
    run_strata,
    run_sweep,
)
from retrieval_eval.bm25 import BM25Index
from retrieval_eval.inverted import InvertedBM25Index
from retrieval_eval.synth import ZipfSampler, generate_corpus, generate_queries


def test_sweep_end_to_end_on_small_sizes():
    sampler = ZipfSampler(vocab_size=2_000)
    queries = generate_queries(20, seed=11, sampler=sampler)
    rows = run_sweep((100, 200), queries, sampler)
    assert [row.n_docs for row in rows] == [100, 200]
    for row in rows:
        # flat work is one full corpus scan per matched query term
        assert 0 < row.docs_scanned_mean <= 4 * row.n_docs
        assert 0 < row.postings_mean <= row.docs_scanned_mean
        assert 0 < row.candidates_mean <= row.n_docs
        assert row.build_flat_s > 0 and row.build_inv_s > 0
        assert row.flat_ms_mean > 0 and row.inv_ms_mean > 0
    # a bigger corpus means more postings for the same queries
    assert rows[1].postings_mean > rows[0].postings_mean


def test_count_identical_finds_a_broken_pair():
    docs = generate_corpus(80, seed=13)
    queries = generate_queries(15, seed=14)
    flat = BM25Index(docs)
    inverted = InvertedBM25Index(docs)
    assert count_identical(flat, inverted, queries, TOP_K) == 15
    detuned = InvertedBM25Index(docs, k1=0.9)
    assert count_identical(flat, detuned, queries, TOP_K) < 15


def test_query_work_matches_hand_count():
    docs = {"d1": "apple banana", "d2": "apple cherry", "d3": "apple durian"}
    inverted = InvertedBM25Index(docs)
    scanned, postings, candidates = query_work(inverted, ["apple banana", "zebra"])
    assert scanned == (2 * 3 + 0) / 2  # two matched terms scan 3 docs each
    assert postings == (4 + 0) / 2
    assert candidates == (3 + 0) / 2


def test_strata_order_costs_as_expected():
    sampler = ZipfSampler(vocab_size=5_000)
    docs = generate_corpus(400, seed=7, sampler=sampler)
    inverted = InvertedBM25Index(docs)
    flat = BM25Index(docs)
    rows = run_strata(inverted, flat, sampler)
    by_name = {row.stratum: row for row in rows}
    assert set(by_name) == {"typical", "common-heavy", "rare-only"}
    assert (
        by_name["common-heavy"].postings_mean
        > by_name["typical"].postings_mean
        > by_name["rare-only"].postings_mean
    )


def test_head_term_share_bounds():
    docs = {"d1": "apple banana", "d2": "apple cherry", "d3": "apple durian"}
    inverted = InvertedBM25Index(docs)
    # apple owns 3 of 4 touched postings; a no-match query is skipped
    assert head_term_share(inverted, ["apple banana", "zebra zebra"]) == 0.75
    assert head_term_share(inverted, ["apple"]) == 1.0
