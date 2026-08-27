"""Compare chunking strategies on retrieval quality over the committed corpus.

Sweeps fixed-size, fixed-with-overlap, and sentence-packed chunking,
indexes each with 02's BM25, and scores every gold query by exact answer
containment. Deterministic: no randomness anywhere, same output every run.
"""

from pathlib import Path

from chunking.chunkers import fixed_chunks, sentence_chunks
from chunking.corpus import load_docs, load_queries, validate
from chunking.evaluate import ConfigResult, evaluate_config
from chunking.retrieval import mean
from chunking.sentences import split_sentences

DATA = Path(__file__).parent / "data"


def build_configs() -> list[tuple[str, object]]:
    configs: list[tuple[str, object]] = []
    for size in (40, 80, 160):
        configs.append(
            (f"fixed-{size}", lambda d, t, s=size: fixed_chunks(d, t, size=s))
        )
    for overlap in (20, 40):
        configs.append(
            (
                f"fixed-80/ov-{overlap}",
                lambda d, t, o=overlap: fixed_chunks(d, t, size=80, overlap=o),
            )
        )
    for budget in (40, 80, 160):
        configs.append(
            (f"sentence-{budget}", lambda d, t, b=budget: sentence_chunks(d, t, budget=b))
        )
    return configs


def print_table(results: list[ConfigResult]) -> None:
    header = (
        f"{'config':<16} {'chunks':>6} {'w/chunk':>8} {'idx words':>9} "
        f"{'split%':>7} {'hit@1':>6} {'hit@5':>6} {'mrr@10':>7} {'ctx w@5':>8}"
    )
    print(header)
    print("-" * len(header))
    for r in results:
        print(
            f"{r.name:<16} {r.n_chunks:>6} {r.mean_chunk_words:>8.1f} {r.index_words:>9} "
            f"{100 * r.split_rate:>6.1f}% {r.hit_rate_at_1:>6.3f} {r.hit_rate_at_k:>6.3f} "
            f"{r.mrr_at_k:>7.3f} {r.mean_context_words:>8.1f}"
        )


def print_split_autopsy(results: dict[str, ConfigResult]) -> None:
    print("\n== where fixed-size chunking loses queries ==")
    for name in ("fixed-40", "fixed-80", "fixed-160"):
        r = results[name]
        splits = [q for q in r.per_query if q.answer_split]
        misses = r.misses_at_k()
        split_misses = [q for q in misses if q.answer_split]
        print(
            f"{name}: {len(splits)}/{len(r.per_query)} answers split by a boundary, "
            f"{len(misses)} queries missed at k=5, {len(split_misses)} of those misses are splits"
        )
        if splits:
            coverage = mean([q.best_coverage for q in splits])
            print(
                f"  split answers still keep {100 * coverage:.1f}% of their text "
                f"in the best chunk on average"
            )

    print("\n== does overlap buy the splits back? (fixed-80 base) ==")
    base = results["fixed-80"]
    base_split_ids = {q.query.id for q in base.per_query if q.answer_split}
    for name in ("fixed-80/ov-20", "fixed-80/ov-40"):
        r = results[name]
        still_split = {q.query.id for q in r.per_query if q.answer_split}
        recovered = base_split_ids - still_split
        newly_split = still_split - base_split_ids
        extra_index = r.index_words - base.index_words
        print(
            f"{name}: {len(recovered)}/{len(base_split_ids)} split answers made whole, "
            f"{len(newly_split)} newly split (overlap moves every boundary, it does not "
            f"only add windows), index grows {extra_index:+} words "
            f"({100 * extra_index / base.index_words:+.1f}%)"
        )


def print_category_split(results: dict[str, ConfigResult]) -> None:
    print("\n== keyword vs paraphrase (mrr@10) ==")
    for name in ("fixed-80", "fixed-80/ov-20", "sentence-80"):
        r = results[name]
        for category in ("keyword", "paraphrase"):
            rrs = [q.rr_at_k for q in r.per_query if q.query.category == category]
            print(f"{name:<16} {category:<10} {mean(rrs):.3f}  (n={len(rrs)})")


def main() -> None:
    docs = load_docs(DATA / "corpus.jsonl")
    queries = load_queries(DATA / "queries.jsonl")
    validate(docs, queries)

    total_words = sum(len(d.text.split()) for d in docs)
    total_sentences = sum(len(split_sentences(d.text)) for d in docs)
    print(
        f"corpus: {len(docs)} docs, {total_words} words, {total_sentences} sentences; "
        f"{len(queries)} gold queries "
        f"({sum(q.category == 'keyword' for q in queries)} keyword, "
        f"{sum(q.category == 'paraphrase' for q in queries)} paraphrase)\n"
    )

    results = [evaluate_config(name, docs, queries, chunker) for name, chunker in build_configs()]
    by_name = {r.name: r for r in results}

    print_table(results)
    print_split_autopsy(by_name)
    print_category_split(by_name)


if __name__ == "__main__":
    main()
