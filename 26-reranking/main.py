"""Two-stage retrieval: what a reranker buys, what it costs, and when it hurts.

Prints first-stage baselines, a rerank depth sweep per scorer, the oracle
ceiling, the direction check (weak scorer on strong candidates), and paired
bootstrap intervals on the headline gaps.
"""

from reranking.data import load_corpus, load_queries
from reranking.evaluate import DEPTHS, HEADLINE_DEPTH, MRR_K, Evaluator, RerankedEval


def show(evaluation) -> str:
    by_cat = evaluation.mrr_by_category
    return (
        f"{evaluation.name:22} mrr@{MRR_K} {evaluation.mrr:.3f}   "
        f"keyword {by_cat['keyword']:.3f}   paraphrase {by_cat['paraphrase']:.3f}   "
        f"latent dots/query {evaluation.latent_dots_per_query:7.1f}"
    )


def show_reranked(result: RerankedEval) -> str:
    return (
        f"{show(result.system)}   gold in shortlist {result.gold_in_shortlist:.3f}   "
        f"+{result.promoted}/-{result.demoted}"
    )


def show_comparison(label: str, comparison) -> str:
    ci = comparison.ci
    return (
        f"{label:38} diff {comparison.diff:+.3f}   "
        f"95% ci [{ci.lo:+.3f}, {ci.hi:+.3f}]   p_le_zero {comparison.p_le_zero:.4f}"
    )


def main() -> None:
    docs = load_corpus()
    queries = load_queries()
    evaluator = Evaluator(docs, queries)
    n_keyword = sum(1 for q in queries if q.category == "keyword")
    n_paraphrase = len(queries) - n_keyword

    print("two-stage retrieval on 03-hybrid-search's corpus and golden queries")
    print(
        f"{len(docs)} docs, {len(queries)} queries "
        f"({n_keyword} keyword, {n_paraphrase} paraphrase), "
        f"latent dim {evaluator.space.term_vectors.shape[1]}, "
        f"vocab {len(evaluator.space.vocab)} terms"
    )

    print("\n== first stages (full corpus scan) ==")
    baselines = {name: evaluator.run_first_stage(name) for name in ("bm25", "lsa", "rrf")}
    for evaluation in baselines.values():
        print(show(evaluation))

    print("\n== reranking bm25's shortlist: depth sweep ==")
    print("(+n/-n = queries improved/hurt vs the first stage at mrr@10)")
    headline = {}
    for scorer_name in ("pooled-lsa", "maxsim", "oracle"):
        for depth in DEPTHS:
            result = evaluator.run_reranked("bm25", scorer_name, depth)
            print(show_reranked(result))
            if depth == HEADLINE_DEPTH:
                headline[scorer_name] = result
        print()

    print("== direction check: weak scorer on strong candidates ==")
    for scorer_name in ("bm25", "maxsim"):
        result = evaluator.run_reranked("lsa", scorer_name, HEADLINE_DEPTH)
        print(show_reranked(result))

    maxsim_headline = headline["maxsim"]
    demoted = sorted(
        q.query_id
        for q in queries
        if maxsim_headline.system.per_query_rr[q.query_id]
        < baselines["bm25"].per_query_rr[q.query_id]
    )
    print(f"\nqueries maxsim@{HEADLINE_DEPTH} demotes below bm25: {', '.join(demoted)}")

    print("\n== is the gap real (paired bootstrap over per-query rr) ==")
    pooled = headline["pooled-lsa"].system
    for label, a, b in (
        (f"bm25+pooled-lsa@{HEADLINE_DEPTH} vs bm25", pooled, baselines["bm25"]),
        (f"bm25+pooled-lsa@{HEADLINE_DEPTH} vs rrf", pooled, baselines["rrf"]),
        (f"bm25+maxsim@{HEADLINE_DEPTH} vs bm25", maxsim_headline.system, baselines["bm25"]),
        (
            f"oracle@{HEADLINE_DEPTH} vs pooled-lsa@{HEADLINE_DEPTH}",
            headline["oracle"].system,
            pooled,
        ),
    ):
        print(show_comparison(label, evaluator.compare(a, b)))


if __name__ == "__main__":
    main()
