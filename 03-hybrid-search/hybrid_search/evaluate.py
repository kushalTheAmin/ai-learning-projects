"""Evaluation harness: run every retriever over the golden query set and
aggregate recall@k and MRR, overall and per query category."""

import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .bm25 import BM25
from .dense import DenseLSA
from .fusion import reciprocal_rank_fusion, weighted_score_fusion
from .metrics import mean, recall_at_k, reciprocal_rank

RECALL_KS = (1, 5)
MRR_K = 10
DEFAULT_ALPHA = 0.5


@dataclass
class QueryResult:
    query_id: str
    category: str
    relevant: set[str]
    rankings: dict[str, list[str]] = field(default_factory=dict)


def load_json(path: Path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def index_corpus(corpus: list[dict]) -> tuple[BM25, DenseLSA, list[str]]:
    """Fit both retrievers over title + body text and return them with the
    doc-id list aligned to their internal indices."""
    doc_ids = [doc["id"] for doc in corpus]
    if len(set(doc_ids)) != len(doc_ids):
        raise ValueError("corpus contains duplicate document ids")
    texts = [f"{doc['title']}. {doc['text']}" for doc in corpus]
    return BM25().fit(texts), DenseLSA().fit(texts), doc_ids


def rank_all(
    bm25: BM25, dense: DenseLSA, doc_ids: list[str], query: str, alpha: float
) -> dict[str, list[str]]:
    """One ranking per retrieval strategy, as ordered doc-id lists."""
    bm25_scores = bm25.scores(query)
    dense_scores = dense.scores(query)
    bm25_rank = np.argsort(-bm25_scores, kind="stable")
    dense_rank = np.argsort(-dense_scores, kind="stable")
    rankings = {
        "bm25": bm25_rank,
        "dense": dense_rank,
        "hybrid_rrf": reciprocal_rank_fusion([bm25_rank, dense_rank]),
        "hybrid_weighted": weighted_score_fusion(bm25_scores, dense_scores, alpha),
    }
    return {name: [doc_ids[i] for i in idx] for name, idx in rankings.items()}


def evaluate(
    corpus: list[dict], queries: list[dict], alpha: float = DEFAULT_ALPHA
) -> list[QueryResult]:
    bm25, dense, doc_ids = index_corpus(corpus)
    known = set(doc_ids)
    results = []
    for q in queries:
        relevant = set(q["relevant"])
        unknown = relevant - known
        if unknown:
            raise ValueError(f"query {q['id']} references unknown docs: {unknown}")
        results.append(
            QueryResult(
                query_id=q["id"],
                category=q["category"],
                relevant=relevant,
                rankings=rank_all(bm25, dense, doc_ids, q["query"], alpha),
            )
        )
    return results


def aggregate(results: list[QueryResult], category: str | None = None) -> dict:
    """Mean recall@k and MRR per strategy, optionally filtered to one
    query category. Returns {strategy: {metric: value}}."""
    subset = [r for r in results if category is None or r.category == category]
    if not subset:
        raise ValueError(f"no queries in category {category!r}")
    strategies = subset[0].rankings.keys()
    table = {}
    for strategy in strategies:
        row = {}
        for k in RECALL_KS:
            row[f"recall@{k}"] = mean(
                [recall_at_k(r.rankings[strategy], r.relevant, k) for r in subset]
            )
        row["mrr"] = mean(
            [reciprocal_rank(r.rankings[strategy], r.relevant, MRR_K) for r in subset]
        )
        table[strategy] = row
    return table


def sweep_alpha(
    corpus: list[dict], queries: list[dict], alphas: list[float]
) -> dict[float, float]:
    """MRR of weighted fusion at each alpha. Runs the retrievers once and
    re-fuses cached scores, so the sweep is cheap."""
    bm25, dense, doc_ids = index_corpus(corpus)
    cached = [
        (set(q["relevant"]), bm25.scores(q["query"]), dense.scores(q["query"]))
        for q in queries
    ]
    result = {}
    for alpha in alphas:
        mrrs = []
        for relevant, bm25_scores, dense_scores in cached:
            ranking = weighted_score_fusion(bm25_scores, dense_scores, alpha)
            mrrs.append(
                reciprocal_rank([doc_ids[i] for i in ranking], relevant, MRR_K)
            )
        result[alpha] = mean(mrrs)
    return result
