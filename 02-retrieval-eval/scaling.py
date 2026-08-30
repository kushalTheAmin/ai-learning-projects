"""Full-scan BM25 vs an inverted index: identical rankings, measured work.

The original scorer loops over every document per query term. This study
pins an inverted-index scorer to bit-identical results, then measures what
each one actually does — documents scanned vs postings touched, wall clock
per query — across corpus sizes and query cost strata.
"""

import time
from dataclasses import dataclass
from pathlib import Path

from retrieval_eval.bm25 import BM25Index
from retrieval_eval.bootstrap import percentile
from retrieval_eval.data import load_corpus, load_queries
from retrieval_eval.inverted import InvertedBM25Index
from retrieval_eval.synth import ZipfSampler, generate_corpus, generate_queries, term

DATA_DIR = Path(__file__).parent / "data"
TOP_K = 10
SWEEP_SIZES = (1_000, 2_000, 4_000, 8_000, 16_000, 32_000)
N_SWEEP_QUERIES = 200
N_STRATUM_QUERIES = 100
EQUIVALENCE_DOCS = 2_000
CORPUS_SEED = 7
QUERY_SEED = 11
PROJECTION_DOCS = 1_000_000


@dataclass
class SweepRow:
    n_docs: int
    build_flat_s: float
    build_inv_s: float
    flat_ms_mean: float
    flat_ms_p95: float
    inv_ms_mean: float
    inv_ms_p95: float
    docs_scanned_mean: float
    postings_mean: float
    candidates_mean: float


@dataclass
class StratumRow:
    stratum: str
    postings_mean: float
    candidates_mean: float
    flat_ms_mean: float
    inv_ms_mean: float


def count_identical(
    flat: BM25Index, inverted: InvertedBM25Index, queries: list[str], top_k: int
) -> int:
    """Queries whose (doc_id, score) result lists match with exact floats."""
    return sum(
        flat.search(query, top_k) == inverted.search(query, top_k)
        for query in queries
    )


def time_queries(index, queries: list[str], top_k: int) -> list[float]:
    timings = []
    for query in queries:
        start = time.perf_counter()
        index.search(query, top_k)
        timings.append(time.perf_counter() - start)
    return timings


def ms_stats(timings: list[float]) -> tuple[float, float]:
    seconds = sorted(timings)
    return (
        1000 * sum(seconds) / len(seconds),
        1000 * percentile(seconds, 0.95),
    )


def query_work(
    inverted: InvertedBM25Index, queries: list[str]
) -> tuple[float, float, float]:
    """Mean docs-scanned (flat's work), postings touched, candidates."""
    n_docs = len(inverted.doc_ids)
    scanned = postings = candidates = 0
    for query in queries:
        _, stats = inverted.search_with_stats(query, TOP_K)
        scanned += stats.terms_matched * n_docs
        postings += stats.postings_touched
        candidates += stats.candidates
    n = len(queries)
    return scanned / n, postings / n, candidates / n


def build_flat(docs: dict[str, str]) -> tuple[BM25Index, float]:
    start = time.perf_counter()
    index = BM25Index(docs)
    return index, time.perf_counter() - start


def build_inverted(docs: dict[str, str]) -> tuple[InvertedBM25Index, float]:
    start = time.perf_counter()
    index = InvertedBM25Index(docs)
    return index, time.perf_counter() - start


def run_sweep(
    sizes: tuple[int, ...], queries: list[str], sampler: ZipfSampler
) -> list[SweepRow]:
    rows = []
    for n_docs in sizes:
        docs = generate_corpus(n_docs, CORPUS_SEED, sampler)
        # built and timed one at a time so the two indexes never both
        # hold the largest corpus in memory
        flat, build_flat_s = build_flat(docs)
        flat_timings = time_queries(flat, queries, TOP_K)
        del flat
        inverted, build_inv_s = build_inverted(docs)
        inv_timings = time_queries(inverted, queries, TOP_K)
        scanned, postings, candidates = query_work(inverted, queries)
        flat_mean, flat_p95 = ms_stats(flat_timings)
        inv_mean, inv_p95 = ms_stats(inv_timings)
        rows.append(
            SweepRow(
                n_docs=n_docs,
                build_flat_s=build_flat_s,
                build_inv_s=build_inv_s,
                flat_ms_mean=flat_mean,
                flat_ms_p95=flat_p95,
                inv_ms_mean=inv_mean,
                inv_ms_p95=inv_p95,
                docs_scanned_mean=scanned,
                postings_mean=postings,
                candidates_mean=candidates,
            )
        )
    return rows


def run_strata(
    inverted: InvertedBM25Index, flat: BM25Index, sampler: ZipfSampler
) -> list[StratumRow]:
    rows = []
    for stratum in ("typical", "common-heavy", "rare-only"):
        queries = generate_queries(N_STRATUM_QUERIES, QUERY_SEED + 1, stratum, sampler)
        _, postings, candidates = query_work(inverted, queries)
        flat_mean, _ = ms_stats(time_queries(flat, queries, TOP_K))
        inv_mean, _ = ms_stats(time_queries(inverted, queries, TOP_K))
        rows.append(StratumRow(stratum, postings, candidates, flat_mean, inv_mean))
    return rows


def head_term_share(inverted: InvertedBM25Index, queries: list[str]) -> float:
    """Mean fraction of a query's touched postings owed to its most
    common single term. Queries matching no term are skipped."""
    shares = []
    for query in queries:
        lengths = [
            len(plist)
            for word in query.split()
            if (plist := inverted.postings.get(word)) is not None
        ]
        if lengths:
            shares.append(max(lengths) / sum(lengths))
    return sum(shares) / len(shares)


def print_equivalence(sampler: ZipfSampler) -> None:
    print("== same math, pinned ==")
    corpus = load_corpus(DATA_DIR / "corpus.jsonl")
    golden = [q.text for q in load_queries(DATA_DIR / "queries.jsonl", corpus)]
    flat = BM25Index(corpus)
    inverted = InvertedBM25Index(corpus)
    n = count_identical(flat, inverted, golden, top_k=len(corpus))
    print(f"golden corpus, full-depth rankings identical: {n}/{len(golden)} queries")
    docs = generate_corpus(EQUIVALENCE_DOCS, CORPUS_SEED, sampler)
    flat = BM25Index(docs)
    inverted = InvertedBM25Index(docs)
    synth_queries = [
        query
        for stratum in ("typical", "common-heavy", "rare-only")
        for query in generate_queries(50, QUERY_SEED + 2, stratum, sampler)
    ]
    n = count_identical(flat, inverted, synth_queries, TOP_K)
    print(
        f"synthetic {EQUIVALENCE_DOCS}-doc corpus, top-{TOP_K} identical: "
        f"{n}/{len(synth_queries)} queries (all strata)"
    )


def print_sweep(rows: list[SweepRow]) -> None:
    print("\n== corpus-size sweep, 200 typical queries per size ==")
    header = (
        f"{'docs':>7} {'build flat':>11} {'build inv':>10} "
        f"{'flat ms/q':>10} {'p95':>7} {'inv ms/q':>9} {'p95':>7} "
        f"{'speedup':>8} {'scanned/q':>10} {'postings/q':>11} {'touch ratio':>12}"
    )
    print(header)
    print("-" * len(header))
    for row in rows:
        print(
            f"{row.n_docs:>7} {row.build_flat_s:>10.2f}s {row.build_inv_s:>9.2f}s "
            f"{row.flat_ms_mean:>10.3f} {row.flat_ms_p95:>7.3f} "
            f"{row.inv_ms_mean:>9.3f} {row.inv_ms_p95:>7.3f} "
            f"{row.flat_ms_mean / row.inv_ms_mean:>7.1f}x "
            f"{row.docs_scanned_mean:>10.0f} {row.postings_mean:>11.0f} "
            f"{row.docs_scanned_mean / row.postings_mean:>11.1f}x"
        )
    last = rows[-1]
    scale = PROJECTION_DOCS / last.n_docs
    print(
        f"\nboth columns grow linearly in corpus size, so at "
        f"{PROJECTION_DOCS:,} docs the measured slope projects to "
        f"~{last.flat_ms_mean * scale / 1000:.1f}s/query flat vs "
        f"~{last.inv_ms_mean * scale / 1000:.2f}s/query inverted"
    )


def print_corpus_profile(inverted: InvertedBM25Index) -> None:
    n_docs = len(inverted.doc_ids)
    print(f"\n== what zipf traffic looks like at {n_docs:,} docs ==")
    total_postings = sum(len(plist) for plist in inverted.postings.values())
    print(
        f"realized vocabulary {len(inverted.postings):,} terms, "
        f"{total_postings:,} postings total"
    )
    for rank in (1, 20, 1_000):
        plist = inverted.postings.get(term(rank), [])
        print(
            f"df of rank-{rank} term: {len(plist):,} docs "
            f"({100 * len(plist) / n_docs:.1f}% of corpus)"
        )


def print_strata(rows: list[StratumRow], share: float, n_docs: int) -> None:
    print(f"\n== query cost strata at {n_docs:,} docs, 100 queries each ==")
    header = (
        f"{'stratum':<14} {'postings/q':>11} {'candidates/q':>13} "
        f"{'flat ms/q':>10} {'inv ms/q':>9} {'speedup':>8}"
    )
    print(header)
    print("-" * len(header))
    for row in rows:
        print(
            f"{row.stratum:<14} {row.postings_mean:>11.0f} "
            f"{row.candidates_mean:>13.0f} {row.flat_ms_mean:>10.3f} "
            f"{row.inv_ms_mean:>9.3f} {row.flat_ms_mean / row.inv_ms_mean:>7.1f}x"
        )
    print(
        f"\non typical queries the single most common term owns "
        f"{100 * share:.1f}% of all postings touched, mean over queries"
    )


def main() -> None:
    sampler = ZipfSampler()
    print_equivalence(sampler)
    sweep_queries = generate_queries(N_SWEEP_QUERIES, QUERY_SEED, "typical", sampler)
    rows = run_sweep(SWEEP_SIZES, sweep_queries, sampler)
    print_sweep(rows)
    docs = generate_corpus(SWEEP_SIZES[-1], CORPUS_SEED, sampler)
    inverted, _ = build_inverted(docs)
    flat, _ = build_flat(docs)
    print_corpus_profile(inverted)
    strata = run_strata(inverted, flat, sampler)
    print_strata(strata, head_term_share(inverted, sweep_queries), len(docs))


if __name__ == "__main__":
    main()
