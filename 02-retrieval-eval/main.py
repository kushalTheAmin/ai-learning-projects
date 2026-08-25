from pathlib import Path

from retrieval_eval.bm25 import BM25Index
from retrieval_eval.data import load_corpus, load_queries
from retrieval_eval.evaluate import SystemReport, evaluate_system, head_to_head
from retrieval_eval.tfidf import TfidfIndex

DATA_DIR = Path(__file__).parent / "data"
K_VALUES = (1, 5)
MRR_K = 10


def print_metrics_table(reports: list[SystemReport]) -> None:
    header = f"{'system':<24}" + "".join(f"recall@{k:<6}" for k in K_VALUES) + f"mrr@{MRR_K}"
    print(header)
    print("-" * len(header))
    for report in reports:
        row = f"{report.name:<24}"
        row += "".join(f"{report.recall_at[k]:<13.3f}" for k in K_VALUES)
        row += f"{report.mrr:.3f}"
        print(row)


def print_disagreements(bm25_report: SystemReport, tfidf_report: SystemReport, limit: int = 3) -> None:
    for outcome_bm25, outcome_tfidf in list(zip(bm25_report.outcomes, tfidf_report.outcomes)):
        if outcome_bm25.reciprocal_rank <= outcome_tfidf.reciprocal_rank:
            continue
        if limit == 0:
            break
        limit -= 1
        query = outcome_bm25.query
        print(f'\n  query: "{query.text}"')
        print(f"  relevant: {', '.join(query.relevant)}")
        print(f"  bm25 top 3:   {', '.join(outcome_bm25.ranked_ids[:3])}")
        print(f"  tf-idf top 3: {', '.join(outcome_tfidf.ranked_ids[:3])}")


def main() -> None:
    corpus = load_corpus(DATA_DIR / "corpus.jsonl")
    queries = load_queries(DATA_DIR / "queries.jsonl", corpus)
    print(f"corpus: {len(corpus)} docs, {len(queries)} labeled queries\n")

    reports = [
        evaluate_system("tf-idf cosine", TfidfIndex(corpus), queries, K_VALUES, MRR_K),
        evaluate_system("bm25 (k1=1.5, b=0.75)", BM25Index(corpus), queries, K_VALUES, MRR_K),
        evaluate_system("bm25 (b=0, no len norm)", BM25Index(corpus, b=0.0), queries, K_VALUES, MRR_K),
    ]
    print_metrics_table(reports)

    tfidf_report, bm25_report = reports[0], reports[1]
    versus = head_to_head(bm25_report, tfidf_report)
    print(
        f"\nhead to head by reciprocal rank: "
        f"bm25 wins {len(versus.wins_a)}, tf-idf wins {len(versus.wins_b)}, ties {versus.ties}"
    )

    print("\nqueries where bm25 beats tf-idf:")
    print_disagreements(bm25_report, tfidf_report)

    misses = [o.query.text for o in bm25_report.outcomes if o.reciprocal_rank == 0.0]
    print(f"\nqueries where bm25 finds nothing relevant in the top {MRR_K} (lexical gap):")
    for text in misses:
        print(f'  "{text}"')


if __name__ == "__main__":
    main()
