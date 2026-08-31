"""Block-max WAND vs plain WAND: skipping inside posting lists, measured.

The pruning study left a floor: on common-heavy queries at top-10, WAND
still scores ~30% of the postings bill, because a common term's
whole-list upper bound is set by its single best posting and stays that
high across the entire list. Block-max WAND cuts each posting list into
fixed-size blocks and stores the exact max gain per block; a pivot whose
terms' current blocks cannot reach the threshold is jumped without
reading a posting. This study pins exactness against the flat scan,
shows the bound-tightening mechanism, sweeps the block size, and re-runs
the stratum and k grids against plain WAND.
"""

import statistics
import time
from dataclasses import dataclass
from pathlib import Path

from retrieval_eval.blockmax import BlockMaxBM25Index
from retrieval_eval.bm25 import BM25Index
from retrieval_eval.data import load_corpus, load_queries
from retrieval_eval.synth import ZipfSampler, generate_corpus, generate_queries, term

DATA_DIR = Path(__file__).parent / "data"
TOP_K = 10
STUDY_DOCS = 32_000
N_STRATUM_QUERIES = 100
EQUIVALENCE_DOCS = 2_000
CORPUS_SEED = 7
QUERY_SEED = 11
BLOCK_SWEEP = (8, 16, 32, 64, 128, 256)
STUDY_BLOCK_SIZE = 32
K_SWEEP = (1, 10, 100, 1_000)


@dataclass
class MethodWork:
    scored_mean: float
    probes_mean: float
    checks_mean: float
    skips_mean: float
    ms_mean: float


def measure(
    index: BlockMaxBM25Index, method: str, queries: list[str], top_k: int
) -> MethodWork:
    scored = probes = checks = skips = 0
    timings = []
    for query in queries:
        start = time.perf_counter()
        if method == "taat":
            _, stats = index.search_with_stats(query, top_k)
        elif method == "wand":
            _, stats = index.search_wand_with_stats(query, top_k)
        else:
            _, stats = index.search_block_max_wand_with_stats(query, top_k)
        timings.append(time.perf_counter() - start)
        if method == "taat":
            scored += stats.postings_touched
        else:
            scored += stats.postings_scored
            probes += stats.probes
            if method == "bmw":
                checks += stats.shallow_checks
                skips += stats.shallow_skips
    n = len(queries)
    return MethodWork(
        scored / n, probes / n, checks / n, skips / n, 1000 * sum(timings) / n
    )


def print_equivalence(sampler: ZipfSampler) -> None:
    print("== same top-k, pinned against the flat scan ==")
    corpus = load_corpus(DATA_DIR / "corpus.jsonl")
    golden = [q.text for q in load_queries(DATA_DIR / "queries.jsonl", corpus)]
    flat = BM25Index(corpus)
    bmw = BlockMaxBM25Index(corpus, block_size=STUDY_BLOCK_SIZE)
    for top_k, label in ((TOP_K, f"top-{TOP_K}"), (len(corpus), "full depth")):
        same = sum(
            bmw.search_block_max_wand(q, top_k) == flat.search(q, top_k)
            for q in golden
        )
        print(f"golden corpus, {label} identical: {same}/{len(golden)} queries")
    docs = generate_corpus(EQUIVALENCE_DOCS, CORPUS_SEED, sampler)
    flat = BM25Index(docs)
    bmw = BlockMaxBM25Index(docs, block_size=STUDY_BLOCK_SIZE)
    synth_queries = [
        query
        for stratum in ("typical", "common-heavy", "rare-only")
        for query in generate_queries(50, QUERY_SEED + 2, stratum, sampler)
    ]
    same = sum(
        bmw.search_block_max_wand(q, TOP_K) == flat.search(q, TOP_K)
        for q in synth_queries
    )
    print(
        f"synthetic {EQUIVALENCE_DOCS}-doc corpus, top-{TOP_K} identical: "
        f"{same}/{len(synth_queries)} queries (all strata, block size "
        f"{STUDY_BLOCK_SIZE})"
    )


def print_bound_profile(index: BlockMaxBM25Index) -> None:
    print(
        f"\n== the mechanism: whole-list bound vs block maxes "
        f"(block size {index.block_size}) =="
    )
    header = (
        f"{'term':<12} {'df':>7} {'list bound':>11} "
        f"{'block max p50':>14} {'p90':>8} {'max':>8}"
    )
    print(header)
    print("-" * len(header))
    for rank in (1, 5, 20, 1_000):
        t = term(rank)
        plist = index.postings.get(t)
        if plist is None:
            continue
        maxes = index.block_max[t]
        quantiles = statistics.quantiles(maxes, n=10) if len(maxes) > 1 else maxes * 9
        print(
            f"rank-{rank:<7} {len(plist):>7,} {index.upper_bounds[t]:>11.4f} "
            f"{statistics.median(maxes):>14.4f} {quantiles[8]:>8.4f} "
            f"{max(maxes):>8.4f}"
        )


def print_block_sweep(index: BlockMaxBM25Index, sampler: ZipfSampler) -> None:
    queries = generate_queries(
        N_STRATUM_QUERIES, QUERY_SEED + 1, "common-heavy", sampler
    )
    postings = sum(len(p) for p in index.postings.values())
    print(
        f"\n== block size sweep, common-heavy, top-{TOP_K}, "
        f"{STUDY_DOCS:,} docs, {N_STRATUM_QUERIES} queries =="
    )
    bill = measure(index, "taat", queries, TOP_K).scored_mean
    wand = measure(index, "wand", queries, TOP_K)
    print(f"taat bill {bill:.0f} postings/q; plain wand {wand.scored_mean:.0f} "
          f"scored/q ({100 * wand.scored_mean / bill:.1f}% of bill), "
          f"{wand.probes_mean:.0f} probes/q, {wand.ms_mean:.3f} ms/q")
    header = (
        f"{'block':>6} {'scored/q':>9} {'% of bill':>10} {'skips/q':>8} "
        f"{'checks/q':>9} {'probes/q':>9} {'directory':>10} {'overhead':>9} "
        f"{'ms/q':>7}"
    )
    print(header)
    print("-" * len(header))
    for block_size in BLOCK_SWEEP:
        index.rebuild_blocks(block_size)
        work = measure(index, "bmw", queries, TOP_K)
        entries = index.block_count()
        print(
            f"{block_size:>6} {work.scored_mean:>9.0f} "
            f"{100 * work.scored_mean / bill:>9.1f}% {work.skips_mean:>8.0f} "
            f"{work.checks_mean:>9.0f} {work.probes_mean:>9.0f} "
            f"{entries:>10,} {100 * entries / postings:>8.1f}% "
            f"{work.ms_mean:>7.3f}"
        )


def print_strata(index: BlockMaxBM25Index, sampler: ZipfSampler) -> None:
    print(
        f"\n== postings scored per query at {STUDY_DOCS:,} docs, top-{TOP_K}, "
        f"block size {index.block_size}, {N_STRATUM_QUERIES} queries each =="
    )
    header = (
        f"{'stratum':<14} {'taat post/q':>12} "
        f"{'wand':>7} {'% of bill':>10} "
        f"{'bmw':>7} {'% of bill':>10} {'skips/q':>8}"
    )
    print(header)
    print("-" * len(header))
    for stratum in ("typical", "common-heavy", "rare-only"):
        queries = generate_queries(N_STRATUM_QUERIES, QUERY_SEED + 1, stratum, sampler)
        bill = measure(index, "taat", queries, TOP_K).scored_mean
        wand = measure(index, "wand", queries, TOP_K)
        bmw = measure(index, "bmw", queries, TOP_K)
        print(
            f"{stratum:<14} {bill:>12.0f} "
            f"{wand.scored_mean:>7.0f} {100 * wand.scored_mean / bill:>9.1f}% "
            f"{bmw.scored_mean:>7.0f} {100 * bmw.scored_mean / bill:>9.1f}% "
            f"{bmw.skips_mean:>8.0f}"
        )


def print_k_sweep(index: BlockMaxBM25Index, sampler: ZipfSampler) -> None:
    queries = generate_queries(
        N_STRATUM_QUERIES, QUERY_SEED + 1, "common-heavy", sampler
    )
    print(
        f"\n== k sweep, common-heavy, block size {index.block_size}, "
        f"{STUDY_DOCS:,} docs =="
    )
    header = (
        f"{'k':>5} {'taat post/q':>12} {'ms/q':>7} "
        f"{'wand':>7} {'% of bill':>10} {'ms/q':>7} "
        f"{'bmw':>7} {'% of bill':>10} {'ms/q':>7}"
    )
    print(header)
    print("-" * len(header))
    for top_k in K_SWEEP:
        taat = measure(index, "taat", queries, top_k)
        bill = taat.scored_mean
        wand = measure(index, "wand", queries, top_k)
        bmw = measure(index, "bmw", queries, top_k)
        print(
            f"{top_k:>5} {bill:>12.0f} {taat.ms_mean:>7.3f} "
            f"{wand.scored_mean:>7.0f} {100 * wand.scored_mean / bill:>9.1f}% "
            f"{wand.ms_mean:>7.3f} "
            f"{bmw.scored_mean:>7.0f} {100 * bmw.scored_mean / bill:>9.1f}% "
            f"{bmw.ms_mean:>7.3f}"
        )


def main() -> None:
    sampler = ZipfSampler()
    print_equivalence(sampler)
    docs = generate_corpus(STUDY_DOCS, CORPUS_SEED, sampler)
    build_start = time.perf_counter()
    index = BlockMaxBM25Index(docs, block_size=STUDY_BLOCK_SIZE)
    build_s = time.perf_counter() - build_start
    print(f"\nbuilt block-max index over {STUDY_DOCS:,} docs in {build_s:.2f}s")
    print_bound_profile(index)
    print_block_sweep(index, sampler)
    index.rebuild_blocks(STUDY_BLOCK_SIZE)
    print_strata(index, sampler)
    print_k_sweep(index, sampler)


if __name__ == "__main__":
    main()
