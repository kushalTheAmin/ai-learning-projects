"""Compare chunking strategies on retrieval quality over the committed corpus.

Sweeps fixed-size, fixed-with-overlap, and sentence-packed chunking,
indexes each with 02's BM25, and scores every gold query by exact answer
containment. Deterministic: no randomness anywhere, same output every run.
"""

from pathlib import Path

from chunking.chunkers import fixed_chunks, sentence_chunks, word_count
from chunking.corpus import Doc, load_docs, load_queries, validate
from chunking.evaluate import HIT_K, ConfigResult, evaluate_config
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
            retrieved = [q for q in splits if q.best_chunk_rank and q.best_chunk_rank <= HIT_K]
            first = [q for q in splits if q.best_chunk_rank == 1]
            print(
                f"  split answers still keep {100 * coverage:.1f}% of their text "
                f"in the best chunk on average"
            )
            print(
                f"  the best chunk was retrieved anyway for {len(retrieved)} of them "
                f"at k={HIT_K}, {len(first)} at rank 1"
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


def print_packing_cost(results: dict[str, ConfigResult], docs: list[Doc]) -> None:
    """What sentence packing does to the answers fixed chunking kept whole.

    Packing redraws every chunk, not only the ones that were cutting an
    answer, so its aggregate win is a recovery on the cut answers netted
    against a drag on the rest. Splitting the two is the control the
    "costs nothing" reading never had.
    """
    print("\n== is sentence packing free? ==")
    for size in (40, 80, 160):
        fixed, packed = results[f"fixed-{size}"], results[f"sentence-{size}"]
        by_fixed = {r.query.id: r for r in fixed.per_query}
        by_packed = {r.query.id: r for r in packed.per_query}
        whole = [q for q, r in by_fixed.items() if not r.answer_split]
        cut = [q for q, r in by_fixed.items() if r.answer_split]
        n = len(fixed.per_query)
        fixed_mrr = mean([by_fixed[q].rr_at_k for q in whole])
        packed_mrr = mean([by_packed[q].rr_at_k for q in whole])
        cut_mrr = mean([by_packed[q].rr_at_k for q in cut])
        print(
            f"fixed-{size} kept {len(whole)}/{n} answers whole: "
            f"mrr@10 {fixed_mrr:.3f} -> {packed_mrr:.3f} under sentence-{size} "
            f"({packed_mrr - fixed_mrr:+.3f}); on the {len(cut)} it cut, "
            f"sentence-{size} scores {cut_mrr:.3f}"
        )
        print(
            f"  overall {fixed.mrr_at_k:.3f} -> {packed.mrr_at_k:.3f} = "
            f"{len(cut) * cut_mrr / n:+.3f} recovered on the cut answers, "
            f"{len(whole) * (packed_mrr - fixed_mrr) / n:+.3f} given back on the whole ones"
        )
        # no overlap in either strategy, so a whole answer has exactly one
        # relevant chunk and "the chunk holding the answer" is unambiguous
        words = {}
        for doc in docs:
            for c in fixed_chunks(doc.id, doc.text, size=size):
                words["f" + c.id] = word_count(c.text)
            for c in sentence_chunks(doc.id, doc.text, budget=size):
                words["s" + c.id] = word_count(c.text)
        print(
            "  the relevant chunk shrinks "
            f"{mean([float(words['f' + by_fixed[q].relevant_chunk_ids[0]]) for q in whole]):.1f} -> "
            f"{mean([float(words['s' + by_packed[q].relevant_chunk_ids[0]]) for q in whole]):.1f} "
            f"words on those {len(whole)}, "
            f"{sum(1 for q in whole if by_packed[q].rr_at_k < by_fixed[q].rr_at_k)} rank worse, "
            f"{sum(1 for q in whole if by_fixed[q].rr_at_k > 0 and by_packed[q].rr_at_k == 0.0)} "
            "fall out of the top 10"
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
    print_packing_cost(by_name, docs)
    print_category_split(by_name)


if __name__ == "__main__":
    main()
