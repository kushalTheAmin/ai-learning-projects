"""Dynamic pruning vs exhaustive term-at-a-time: identical top-k, less work.

The inverted index still scores every posting of every query term. WAND
and MaxScore use an exact per-term score upper bound to skip documents
that cannot reach the current top-k, and stay exact: same scores, same
tie-break. This study pins that equivalence, then measures how much of
the postings bill the bounds skip per query stratum, and where the
saving dies as k grows.
"""

import time
from dataclasses import dataclass
from pathlib import Path

from retrieval_eval.bm25 import BM25Index
from retrieval_eval.data import load_corpus, load_queries
from retrieval_eval.pruned import PrunedBM25Index
from retrieval_eval.synth import ZipfSampler, generate_corpus, generate_queries, term

DATA_DIR = Path(__file__).parent / "data"
TOP_K = 10
STUDY_DOCS = 32_000
N_STRATUM_QUERIES = 100
EQUIVALENCE_DOCS = 2_000
CORPUS_SEED = 7
QUERY_SEED = 11
K_SWEEP = (1, 10, 100, 1_000)

METHODS = ("taat", "maxscore", "wand")


@dataclass
class MethodWork:
    scored_mean: float
    probes_mean: float
    ms_mean: float


def searcher(index: PrunedBM25Index, method: str):
    if method == "taat":
        return index.search_with_stats
    if method == "maxscore":
        return index.search_maxscore_with_stats
    return index.search_wand_with_stats


def ms_mean(timings: list[float]) -> float:
    return 1000 * sum(timings) / len(timings)


def probe_charged_share(work: MethodWork, bill: float) -> float:
    """Share of the term-at-a-time bill a pruner touches, probes included.

    A probe is a binary search that lands on one posting and reads it, so
    charging it as a touched posting is the honest comparison against the
    exhaustive scan. `% of bill` counts only what was scored.
    """
    return (work.scored_mean + work.probes_mean) / bill


def measure(
    index: PrunedBM25Index, method: str, queries: list[str], top_k: int
) -> MethodWork:
    search = searcher(index, method)
    scored = probes = 0
    timings = []
    for query in queries:
        start = time.perf_counter()
        _, stats = search(query, top_k)
        timings.append(time.perf_counter() - start)
        if method == "taat":
            scored += stats.postings_touched
        else:
            scored += stats.postings_scored
            probes += stats.probes
    n = len(queries)
    return MethodWork(scored / n, probes / n, ms_mean(timings))


def count_identical(
    flat: BM25Index, pruned: PrunedBM25Index, queries: list[str], top_k: int
) -> tuple[int, int]:
    """Queries whose (doc_id, score) lists match flat's with exact floats."""
    wand = maxscore = 0
    for query in queries:
        expected = flat.search(query, top_k)
        wand += pruned.search_wand(query, top_k) == expected
        maxscore += pruned.search_maxscore(query, top_k) == expected
    return maxscore, wand


def print_equivalence(sampler: ZipfSampler) -> None:
    print("== same top-k, pinned against the flat scan ==")
    corpus = load_corpus(DATA_DIR / "corpus.jsonl")
    golden = [q.text for q in load_queries(DATA_DIR / "queries.jsonl", corpus)]
    flat = BM25Index(corpus)
    pruned = PrunedBM25Index(corpus)
    for top_k, label in ((TOP_K, f"top-{TOP_K}"), (len(corpus), "full depth")):
        m, w = count_identical(flat, pruned, golden, top_k)
        print(
            f"golden corpus, {label} identical: maxscore {m}/{len(golden)}, "
            f"wand {w}/{len(golden)} queries"
        )
    docs = generate_corpus(EQUIVALENCE_DOCS, CORPUS_SEED, sampler)
    flat = BM25Index(docs)
    pruned = PrunedBM25Index(docs)
    synth_queries = [
        query
        for stratum in ("typical", "common-heavy", "rare-only")
        for query in generate_queries(50, QUERY_SEED + 2, stratum, sampler)
    ]
    m, w = count_identical(flat, pruned, synth_queries, TOP_K)
    print(
        f"synthetic {EQUIVALENCE_DOCS}-doc corpus, top-{TOP_K} identical: "
        f"maxscore {m}/{len(synth_queries)}, wand {w}/{len(synth_queries)} "
        f"queries (all strata)"
    )


def print_strata(index: PrunedBM25Index, sampler: ZipfSampler) -> None:
    print(
        f"\n== postings scored per query at {STUDY_DOCS:,} docs, "
        f"top-{TOP_K}, {N_STRATUM_QUERIES} queries each =="
    )
    header = (
        f"{'stratum':<14} {'taat post/q':>12} "
        f"{'maxscore':>9} {'probes':>7} {'% of bill':>10} {'+probes':>8} "
        f"{'wand':>7} {'probes':>7} {'% of bill':>10} {'+probes':>8}"
    )
    print(header)
    print("-" * len(header))
    timing_rows = []
    for stratum in ("typical", "common-heavy", "rare-only"):
        queries = generate_queries(N_STRATUM_QUERIES, QUERY_SEED + 1, stratum, sampler)
        work = {m: measure(index, m, queries, TOP_K) for m in METHODS}
        bill = work["taat"].scored_mean
        print(
            f"{stratum:<14} {bill:>12.0f} "
            f"{work['maxscore'].scored_mean:>9.0f} "
            f"{work['maxscore'].probes_mean:>7.0f} "
            f"{100 * work['maxscore'].scored_mean / bill:>9.1f}% "
            f"{100 * probe_charged_share(work['maxscore'], bill):>7.1f}% "
            f"{work['wand'].scored_mean:>7.0f} "
            f"{work['wand'].probes_mean:>7.0f} "
            f"{100 * work['wand'].scored_mean / bill:>9.1f}% "
            f"{100 * probe_charged_share(work['wand'], bill):>7.1f}%"
        )
        timing_rows.append((stratum, work))
    print("\nwall clock, ms per query (same runs)")
    header = f"{'stratum':<14} {'taat':>8} {'maxscore':>9} {'wand':>8}"
    print(header)
    print("-" * len(header))
    for stratum, work in timing_rows:
        print(
            f"{stratum:<14} {work['taat'].ms_mean:>8.3f} "
            f"{work['maxscore'].ms_mean:>9.3f} {work['wand'].ms_mean:>8.3f}"
        )


def print_k_sweep(index: PrunedBM25Index, sampler: ZipfSampler) -> None:
    queries = generate_queries(
        N_STRATUM_QUERIES, QUERY_SEED + 1, "common-heavy", sampler
    )
    print(
        f"\n== where the bound stops paying: k sweep, common-heavy, "
        f"{STUDY_DOCS:,} docs =="
    )
    header = (
        f"{'k':>5} {'taat post/q':>12} "
        f"{'maxscore':>9} {'% of bill':>10} {'ms/q':>7} "
        f"{'wand':>7} {'% of bill':>10} {'ms/q':>7}"
    )
    print(header)
    print("-" * len(header))
    for top_k in K_SWEEP:
        work = {m: measure(index, m, queries, top_k) for m in METHODS}
        bill = work["taat"].scored_mean
        print(
            f"{top_k:>5} {bill:>12.0f} "
            f"{work['maxscore'].scored_mean:>9.0f} "
            f"{100 * work['maxscore'].scored_mean / bill:>9.1f}% "
            f"{work['maxscore'].ms_mean:>7.3f} "
            f"{work['wand'].scored_mean:>7.0f} "
            f"{100 * work['wand'].scored_mean / bill:>9.1f}% "
            f"{work['wand'].ms_mean:>7.3f}"
        )


def print_bound_profile(index: PrunedBM25Index) -> None:
    print(f"\n== why common terms prune well at top-{TOP_K} ==")
    for rank in (1, 20, 1_000):
        t = term(rank)
        plist = index.postings.get(t)
        if plist is None:
            continue
        print(
            f"rank-{rank} term: df {len(plist):,}, "
            f"score upper bound {index.upper_bounds[t]:.4f}"
        )


def main() -> None:
    sampler = ZipfSampler()
    print_equivalence(sampler)
    docs = generate_corpus(STUDY_DOCS, CORPUS_SEED, sampler)
    build_start = time.perf_counter()
    index = PrunedBM25Index(docs)
    build_s = time.perf_counter() - build_start
    print(f"\nbuilt pruned index over {STUDY_DOCS:,} docs in {build_s:.2f}s")
    print_bound_profile(index)
    print_strata(index, sampler)
    print_k_sweep(index, sampler)


if __name__ == "__main__":
    main()
