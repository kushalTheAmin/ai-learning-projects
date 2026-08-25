"""Entry point: benchmark BM25 vs dense (LSA) vs hybrid fusion on the
committed corpus and golden query set, printing recall@k and MRR overall
and per query category."""

from pathlib import Path

from hybrid_search.evaluate import (
    DEFAULT_ALPHA,
    RECALL_KS,
    aggregate,
    evaluate,
    load_json,
    sweep_alpha,
)
from hybrid_search.metrics import reciprocal_rank

DATA_DIR = Path(__file__).parent / "data"
STRATEGY_LABELS = {
    "bm25": "bm25 (lexical)",
    "dense": "dense (lsa)",
    "hybrid_rrf": "hybrid (rrf)",
    "hybrid_weighted": f"hybrid (weighted a={DEFAULT_ALPHA})",
}


def print_table(title: str, table: dict) -> None:
    metric_names = [f"recall@{k}" for k in RECALL_KS] + ["mrr"]
    print(f"\n{title}")
    header = f"  {'strategy':<26}" + "".join(f"{m:>12}" for m in metric_names)
    print(header)
    print("  " + "-" * (len(header) - 2))
    for strategy, row in table.items():
        label = STRATEGY_LABELS[strategy]
        cells = "".join(f"{row[m]:>12.3f}" for m in metric_names)
        print(f"  {label:<26}{cells}")


def print_biggest_wins(results, queries) -> None:
    """Show the query with the largest reciprocal-rank margin in each
    direction, or say plainly when a retriever never wins."""
    query_text = {q["id"]: q["query"] for q in queries}
    for winner, loser in [("bm25", "dense"), ("dense", "bm25")]:
        margin = lambda r: reciprocal_rank(r.rankings[winner], r.relevant) - (
            reciprocal_rank(r.rankings[loser], r.relevant)
        )
        best = max(results, key=margin)
        if margin(best) <= 0:
            print(f"\n  {winner} never beats {loser} on this query set")
            continue
        w_rank = _first_relevant_rank(best.rankings[winner], best.relevant)
        l_rank = _first_relevant_rank(best.rankings[loser], best.relevant)
        print(f'\n  [{best.category}] "{query_text[best.query_id]}"')
        print(f"    {winner} ranks the answer #{w_rank}, {loser} ranks it #{l_rank}")


def _first_relevant_rank(ranking, relevant) -> str:
    for position, doc_id in enumerate(ranking, start=1):
        if doc_id in relevant:
            return str(position)
    return "not retrieved"


def main() -> None:
    corpus = load_json(DATA_DIR / "corpus.json")
    queries = load_json(DATA_DIR / "queries.json")
    n_keyword = sum(1 for q in queries if q["category"] == "keyword")
    n_paraphrase = len(queries) - n_keyword
    print(
        f"corpus: {len(corpus)} docs | queries: {len(queries)} "
        f"({n_keyword} keyword, {n_paraphrase} paraphrase)"
    )

    results = evaluate(corpus, queries)
    print_table("ALL QUERIES", aggregate(results))
    print_table(f"KEYWORD QUERIES (n={n_keyword})", aggregate(results, "keyword"))
    print_table(
        f"PARAPHRASE QUERIES (n={n_paraphrase})", aggregate(results, "paraphrase")
    )

    print("\nWHERE EACH RETRIEVER WINS")
    print_biggest_wins(results, queries)

    alphas = [round(0.1 * i, 1) for i in range(11)]
    sweep = sweep_alpha(corpus, queries, alphas)
    print("\nWEIGHTED FUSION ALPHA SWEEP (0 = pure bm25, 1 = pure dense)")
    print("  alpha: " + "  ".join(f"{a:>5.1f}" for a in alphas))
    print("  mrr:   " + "  ".join(f"{sweep[a]:>5.3f}" for a in alphas))
    best_alpha = max(sweep, key=sweep.get)
    print(f"  best alpha on this query set: {best_alpha} (mrr {sweep[best_alpha]:.3f})")


if __name__ == "__main__":
    main()
