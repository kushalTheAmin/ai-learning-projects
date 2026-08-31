from pathlib import Path

import pytest

from retrieval_eval.blockmax import BlockMaxBM25Index
from retrieval_eval.bm25 import BM25Index
from retrieval_eval.data import load_corpus, load_queries
from retrieval_eval.pruned import PrunedBM25Index
from retrieval_eval.synth import generate_corpus, generate_queries

DATA_DIR = Path(__file__).parent.parent / "data"


def test_block_directory_is_exact():
    index = BlockMaxBM25Index(generate_corpus(200, seed=4), block_size=16)
    for term, plist in index.postings.items():
        lasts = index.block_last[term]
        maxes = index.block_max[term]
        assert len(lasts) == len(maxes) == -(-len(plist) // 16)
        for bidx in range(len(lasts)):
            block = plist[bidx * 16 : (bidx + 1) * 16]
            assert lasts[bidx] == block[-1][0]
            gains = [index._gain(index.idf[term], tf, i) for i, tf in block]
            assert maxes[bidx] == max(gains)


def test_block_max_never_exceeds_whole_list_bound():
    index = BlockMaxBM25Index(generate_corpus(200, seed=4), block_size=8)
    for term, maxes in index.block_max.items():
        assert max(maxes) == index.upper_bounds[term]
        for m in maxes:
            assert m <= index.upper_bounds[term]


@pytest.mark.parametrize("block_size", (1, 4, 64))
def test_identical_to_flat_scan_on_golden_dataset(block_size):
    # exact float equality on purpose: block skipping must change the
    # work done, never the arithmetic or the ordering
    corpus = load_corpus(DATA_DIR / "corpus.jsonl")
    queries = load_queries(DATA_DIR / "queries.jsonl", corpus)
    flat = BM25Index(corpus)
    bmw = BlockMaxBM25Index(corpus, block_size=block_size)
    for query in queries:
        for top_k in (1, 3, 10, len(corpus)):
            assert bmw.search_block_max_wand(query.text, top_k) == flat.search(
                query.text, top_k
            )


@pytest.mark.parametrize("block_size", (2, 16, 128))
def test_identical_to_flat_scan_on_synthetic_corpus(block_size):
    docs = generate_corpus(300, seed=5)
    flat = BM25Index(docs)
    bmw = BlockMaxBM25Index(docs, block_size=block_size)
    queries = [
        query
        for stratum in ("typical", "common-heavy", "rare-only")
        for query in generate_queries(20, seed=6, stratum=stratum)
    ]
    for query in queries:
        for top_k in (1, 10):
            assert bmw.search_block_max_wand(query, top_k) == flat.search(query, top_k)


@pytest.mark.parametrize("block_size", (1, 2, 64))
def test_all_docs_tie_and_the_smallest_ids_win(block_size):
    # every doc scores exactly the term's block max, so the k-th score
    # equals every remaining block bound. skipping on block_sum <=
    # threshold would jump the later-indexed small-id docs; only a
    # strictly smaller bound is a sound skip. index order deliberately
    # disagrees with id order.
    docs = {doc_id: "apple" for doc_id in ("z9", "y8", "c1", "a0", "m5")}
    flat = BM25Index(docs)
    bmw = BlockMaxBM25Index(docs, block_size=block_size)
    expected = flat.search("apple", 2)
    assert [doc_id for doc_id, _ in expected] == ["a0", "c1"]
    assert bmw.search_block_max_wand("apple", 2) == expected


@pytest.mark.parametrize("block_size", (1, 3, 64))
def test_tie_heavy_multi_term_corpus_matches_flat(block_size):
    docs = {}
    for i in range(30):
        docs[f"dup-{29 - i:02d}"] = "apple banana cherry"
    docs["extra-1"] = "apple banana"
    docs["extra-2"] = "banana cherry apple apple"
    flat = BM25Index(docs)
    bmw = BlockMaxBM25Index(docs, block_size=block_size)
    for query in ("apple", "apple banana", "cherry banana apple"):
        for top_k in (1, 5, len(docs)):
            assert bmw.search_block_max_wand(query, top_k) == flat.search(query, top_k)


def test_huge_block_size_does_no_worse_than_wand():
    # one block per list makes the block max the whole-list bound, so
    # the shallow test can only reject pivots plain wand would also
    # never score; postings scored must not exceed wand's
    docs = generate_corpus(300, seed=5)
    wand = PrunedBM25Index(docs)
    bmw = BlockMaxBM25Index(docs, block_size=10_000)
    for stratum in ("typical", "common-heavy"):
        for query in generate_queries(10, seed=6, stratum=stratum):
            expected, wand_stats = wand.search_wand_with_stats(query, 10)
            got, bmw_stats = bmw.search_block_max_wand_with_stats(query, 10)
            assert got == expected
            assert bmw_stats.postings_scored <= wand_stats.postings_scored


def test_small_blocks_skip_deeper_than_wand():
    # the point of the block directory: on common-heavy queries the
    # shallow bound must actually fire and cut postings below plain wand
    docs = generate_corpus(300, seed=5)
    wand = PrunedBM25Index(docs)
    bmw = BlockMaxBM25Index(docs, block_size=8)
    wand_scored = bmw_scored = skips = 0
    for query in generate_queries(20, seed=6, stratum="common-heavy"):
        expected, wand_stats = wand.search_wand_with_stats(query, 1)
        got, bmw_stats = bmw.search_block_max_wand_with_stats(query, 1)
        assert got == expected
        assert bmw_stats.postings_available == wand_stats.postings_available
        assert bmw_stats.terms_matched == wand_stats.terms_matched
        wand_scored += wand_stats.postings_scored
        bmw_scored += bmw_stats.postings_scored
        skips += bmw_stats.shallow_skips
    assert skips > 0
    assert bmw_scored < wand_scored


def test_rebuild_blocks_changes_granularity_not_results():
    docs = generate_corpus(300, seed=5)
    bmw = BlockMaxBM25Index(docs, block_size=64)
    queries = generate_queries(10, seed=6, stratum="typical")
    before = [bmw.search_block_max_wand(q, 10) for q in queries]
    coarse_blocks = bmw.block_count()
    bmw.rebuild_blocks(4)
    assert bmw.block_size == 4
    assert bmw.block_count() > coarse_blocks
    after = [bmw.search_block_max_wand(q, 10) for q in queries]
    assert after == before


def test_block_count_matches_directory():
    docs = {"d1": "apple banana", "d2": "apple cherry", "d3": "apple"}
    index = BlockMaxBM25Index(docs, block_size=2)
    # apple df 3 -> 2 blocks, banana df 1 -> 1, cherry df 1 -> 1
    assert index.block_count() == 4


def test_invalid_block_size_rejected():
    with pytest.raises(ValueError):
        BlockMaxBM25Index({"d1": "apple"}, block_size=0)
    index = BlockMaxBM25Index({"d1": "apple"})
    with pytest.raises(ValueError):
        index.rebuild_blocks(-3)


def test_stats_on_a_tiny_hand_checked_corpus():
    index = BlockMaxBM25Index(
        {"d1": "apple banana", "d2": "apple cherry", "d3": "apple durian"},
        block_size=2,
    )
    results, stats = index.search_block_max_wand_with_stats("apple banana", top_k=10)
    assert [doc_id for doc_id, _ in results] == ["d1", "d2", "d3"]
    # top_k covers every candidate, so nothing can be skipped: all four
    # postings (df 3 + df 1) are scored
    assert stats.postings_scored == 4
    assert stats.postings_available == 4
    assert stats.docs_scored == 3
    assert stats.docs_abandoned == 0


def test_empty_query_unknown_terms_and_empty_corpus():
    index = BlockMaxBM25Index({"d1": "apple"})
    for query in ("", "zebra", "?!"):
        assert index.search_block_max_wand(query, 10) == []
    empty = BlockMaxBM25Index({})
    assert empty.search_block_max_wand("apple", 10) == []
    assert empty.block_count() == 0


def test_top_k_zero_returns_nothing():
    index = BlockMaxBM25Index({"d1": "apple", "d2": "apple"})
    assert index.search_block_max_wand("apple", 0) == []


def test_matches_fewer_than_top_k():
    docs = {"d1": "apple pie", "d2": "banana bread", "d3": "cherry cake"}
    flat = BM25Index(docs)
    bmw = BlockMaxBM25Index(docs, block_size=1)
    expected = flat.search("apple", 10)
    got = bmw.search_block_max_wand("apple", 10)
    assert got == expected
    assert len(got) == 1


def test_duplicate_query_terms_count_once():
    index = BlockMaxBM25Index({"d1": "cat sat", "d2": "cat cat"}, block_size=1)
    assert index.search_block_max_wand("cat", 10) == index.search_block_max_wand(
        "cat cat", 10
    )


def test_unicode_matches_flat_scan():
    docs = {
        "d1": "café au lait, s'il vous plaît",
        "d2": "naïve résumé señor",
        "d3": "日本語 テスト 文書",
    }
    flat = BM25Index(docs)
    bmw = BlockMaxBM25Index(docs, block_size=2)
    for query in ("CAFÉ", "résumé naïve", "日本語", "plaît señor café"):
        assert bmw.search_block_max_wand(query, 10) == flat.search(query, 10)


def test_oversized_query_matches_flat_scan():
    docs = generate_corpus(50, seed=9)
    flat = BM25Index(docs)
    bmw = BlockMaxBM25Index(docs, block_size=4)
    query = " ".join(docs.values())  # every term in the corpus at once
    assert bmw.search_block_max_wand(query, 10) == flat.search(query, 10)


def test_lists_ending_before_the_pivot_contribute_nothing():
    # a pivot-set term whose postings end before the pivot doc must add
    # zero to the shallow bound and not constrain the jump. "early" only
    # appears in low-index docs; "apple" carries the pivot further out.
    docs = {}
    for i in range(4):
        docs[f"e{i}"] = "early apple"
    for i in range(40):
        docs[f"m{i:02d}"] = "apple apple"
    flat = BM25Index(docs)
    bmw = BlockMaxBM25Index(docs, block_size=2)
    for top_k in (1, 3, 10):
        assert bmw.search_block_max_wand("early apple", top_k) == flat.search(
            "early apple", top_k
        )


def test_taat_and_wand_are_still_the_inherited_baselines():
    docs = generate_corpus(100, seed=3)
    flat = BM25Index(docs)
    bmw = BlockMaxBM25Index(docs, block_size=8)
    for query in generate_queries(10, seed=2):
        assert bmw.search(query, 10) == flat.search(query, 10)
        assert bmw.search_wand(query, 10) == flat.search(query, 10)
