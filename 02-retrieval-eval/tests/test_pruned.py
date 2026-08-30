from pathlib import Path

from retrieval_eval.bm25 import BM25Index
from retrieval_eval.data import load_corpus, load_queries
from retrieval_eval.pruned import PrunedBM25Index
from retrieval_eval.synth import generate_corpus, generate_queries

DATA_DIR = Path(__file__).parent.parent / "data"


def both_searches(index: PrunedBM25Index, query: str, top_k: int):
    return index.search_maxscore(query, top_k), index.search_wand(query, top_k)


def test_upper_bound_is_the_exact_max_gain():
    index = PrunedBM25Index(generate_corpus(200, seed=4))
    for term, plist in index.postings.items():
        gains = [index._gain(index.idf[term], tf, i) for i, tf in plist]
        assert index.upper_bounds[term] == max(gains)


def test_identical_to_flat_scan_on_golden_dataset():
    # exact float equality on purpose: pruning must change the work done,
    # never the arithmetic or the ordering
    corpus = load_corpus(DATA_DIR / "corpus.jsonl")
    queries = load_queries(DATA_DIR / "queries.jsonl", corpus)
    flat = BM25Index(corpus)
    pruned = PrunedBM25Index(corpus)
    for query in queries:
        for top_k in (1, 3, 10, len(corpus)):
            expected = flat.search(query.text, top_k)
            maxscore, wand = both_searches(pruned, query.text, top_k)
            assert maxscore == expected
            assert wand == expected


def test_identical_to_flat_scan_on_synthetic_corpus():
    docs = generate_corpus(300, seed=5)
    flat = BM25Index(docs)
    pruned = PrunedBM25Index(docs)
    queries = [
        query
        for stratum in ("typical", "common-heavy", "rare-only")
        for query in generate_queries(20, seed=6, stratum=stratum)
    ]
    for query in queries:
        for top_k in (1, 10):
            expected = flat.search(query, top_k)
            maxscore, wand = both_searches(pruned, query, top_k)
            assert maxscore == expected
            assert wand == expected


def test_all_docs_tie_and_the_smallest_ids_win():
    # every doc scores exactly the term's upper bound, so the k-th score
    # equals every candidate's bound. pruning on bound <= threshold would
    # skip the later-indexed small-id docs; only bound < threshold is
    # sound. index order deliberately disagrees with id order.
    docs = {doc_id: "apple" for doc_id in ("z9", "y8", "c1", "a0", "m5")}
    flat = BM25Index(docs)
    pruned = PrunedBM25Index(docs)
    expected = flat.search("apple", 2)
    assert [doc_id for doc_id, _ in expected] == ["a0", "c1"]
    maxscore, wand = both_searches(pruned, "apple", 2)
    assert maxscore == expected
    assert wand == expected


def test_tie_heavy_multi_term_corpus_matches_flat():
    docs = {}
    for i in range(30):
        docs[f"dup-{29 - i:02d}"] = "apple banana cherry"
    docs["extra-1"] = "apple banana"
    docs["extra-2"] = "banana cherry apple apple"
    flat = BM25Index(docs)
    pruned = PrunedBM25Index(docs)
    for query in ("apple", "apple banana", "cherry banana apple"):
        for top_k in (1, 5, len(docs)):
            expected = flat.search(query, top_k)
            maxscore, wand = both_searches(pruned, query, top_k)
            assert maxscore == expected
            assert wand == expected


def test_pruning_actually_skips_postings():
    # the equivalence tests would pass with bounds so loose nothing is
    # ever skipped; this one fails if the pruning machinery goes inert
    docs = generate_corpus(300, seed=5)
    pruned = PrunedBM25Index(docs)
    queries = generate_queries(20, seed=6, stratum="common-heavy")
    bill = ms_scored = wand_scored = 0
    for query in queries:
        _, taat = pruned.search_with_stats(query, 1)
        _, ms = pruned.search_maxscore_with_stats(query, 1)
        _, wand = pruned.search_wand_with_stats(query, 1)
        bill += taat.postings_touched
        ms_scored += ms.postings_scored
        wand_scored += wand.postings_scored
        assert ms.postings_available == taat.postings_touched
        assert wand.postings_available == taat.postings_touched
        assert ms.terms_matched == taat.terms_matched
        assert wand.terms_matched == taat.terms_matched
    assert ms_scored < bill
    assert wand_scored < bill


def test_stats_on_a_tiny_hand_checked_corpus():
    index = PrunedBM25Index(
        {"d1": "apple banana", "d2": "apple cherry", "d3": "apple durian"}
    )
    results, stats = index.search_wand_with_stats("apple banana", top_k=10)
    assert [doc_id for doc_id, _ in results] == ["d1", "d2", "d3"]
    # top_k covers every candidate, so nothing can be pruned: all four
    # postings (df 3 + df 1) are scored
    assert stats.postings_scored == 4
    assert stats.postings_available == 4
    assert stats.docs_scored == 3
    results, stats = index.search_maxscore_with_stats("apple banana", top_k=10)
    assert [doc_id for doc_id, _ in results] == ["d1", "d2", "d3"]
    assert stats.postings_scored == 4
    assert stats.docs_scored == 3
    assert stats.docs_abandoned == 0


def test_empty_query_unknown_terms_and_empty_corpus():
    index = PrunedBM25Index({"d1": "apple"})
    for query in ("", "zebra", "?!"):
        assert index.search_maxscore(query, 10) == []
        assert index.search_wand(query, 10) == []
    empty = PrunedBM25Index({})
    assert empty.search_maxscore("apple", 10) == []
    assert empty.search_wand("apple", 10) == []


def test_top_k_zero_returns_nothing():
    index = PrunedBM25Index({"d1": "apple", "d2": "apple"})
    assert index.search_maxscore("apple", 0) == []
    assert index.search_wand("apple", 0) == []


def test_matches_fewer_than_top_k():
    docs = {"d1": "apple pie", "d2": "banana bread", "d3": "cherry cake"}
    flat = BM25Index(docs)
    pruned = PrunedBM25Index(docs)
    expected = flat.search("apple", 10)
    maxscore, wand = both_searches(pruned, "apple", 10)
    assert maxscore == expected == wand
    assert len(wand) == 1


def test_duplicate_query_terms_count_once():
    index = PrunedBM25Index({"d1": "cat sat", "d2": "cat cat"})
    for search in (index.search_maxscore, index.search_wand):
        assert search("cat", 10) == search("cat cat", 10)


def test_single_rare_term_query_prunes_nothing_and_matches():
    docs = generate_corpus(200, seed=8)
    flat = BM25Index(docs)
    pruned = PrunedBM25Index(docs)
    expected = flat.search("t1500", 10)
    maxscore, wand = both_searches(pruned, "t1500", 10)
    assert maxscore == expected
    assert wand == expected


def test_unicode_matches_flat_scan():
    docs = {
        "d1": "café au lait, s'il vous plaît",
        "d2": "naïve résumé señor",
        "d3": "日本語 テスト 文書",
    }
    flat = BM25Index(docs)
    pruned = PrunedBM25Index(docs)
    for query in ("CAFÉ", "résumé naïve", "日本語", "plaît señor café"):
        expected = flat.search(query, 10)
        maxscore, wand = both_searches(pruned, query, 10)
        assert maxscore == expected
        assert wand == expected


def test_oversized_query_matches_flat_scan():
    docs = generate_corpus(50, seed=9)
    flat = BM25Index(docs)
    pruned = PrunedBM25Index(docs)
    query = " ".join(docs.values())  # every term in the corpus at once
    expected = flat.search(query, 10)
    maxscore, wand = both_searches(pruned, query, 10)
    assert maxscore == expected
    assert wand == expected


def test_taat_search_is_still_the_inherited_baseline():
    docs = generate_corpus(100, seed=3)
    flat = BM25Index(docs)
    pruned = PrunedBM25Index(docs)
    for query in generate_queries(10, seed=2):
        assert pruned.search(query, 10) == flat.search(query, 10)
