"""Runs first-stage retrievers and two-stage rerank pipelines over the golden set.

Every pipeline is scored with 02's metrics on 03's queries, so any measured
difference is attributable to the ordering machinery alone. A reranked
ranking is the shortlist reordered by one scorer with the rest of the
first-stage ranking appended unchanged: exactly what a production two-stage
retriever returns, and it makes the shortlist depth a hard ceiling on what
the reranker can fix (a gold doc the first stage left below the cutoff
keeps its first-stage rank).

Cost is counted in latent dot products per query: one per document for the
bi-encoder's pooled scan, one per term pair for MaxSim. BM25's postings
work is a different currency and is reported as zero latent dots, not as
free.
"""

from dataclasses import dataclass

from .data import CATEGORIES, Document, Query, validate_relevance
from .rerank import Bm25Scorer, MaxSimScorer, OracleScorer, PooledLsaScorer, rerank
from .reuse import (
    BM25,
    DenseLSA,
    PairedComparison,
    mean,
    paired_bootstrap,
    recall_at_k,
    reciprocal_rank,
    reciprocal_rank_fusion,
)
from .term_space import TermSpace

MRR_K = 10
DEPTHS = (5, 10, 20, 50, 100)
HEADLINE_DEPTH = 20
FIRST_STAGES = ("bm25", "lsa")


@dataclass(frozen=True)
class SystemEval:
    name: str
    mrr: float
    mrr_by_category: dict[str, float]
    per_query_rr: dict[str, float]
    latent_dots_per_query: float


@dataclass(frozen=True)
class RerankedEval:
    system: SystemEval
    depth: int
    gold_in_shortlist: float  # first-stage recall@depth: the rerank ceiling
    promoted: int  # queries whose rr@MRR_K improved over the first stage
    demoted: int  # queries whose rr@MRR_K got worse


class Evaluator:
    def __init__(self, docs: list[Document], queries: list[Query]):
        validate_relevance(docs, queries)
        self.docs = docs
        self.queries = queries
        self.doc_ids = [d.doc_id for d in docs]
        texts = [d.text for d in docs]
        self.bm25 = BM25().fit(texts)
        self.lsa = DenseLSA().fit(texts)
        self.space = TermSpace(self.lsa, self.doc_ids, texts)
        self.scorers = {
            "maxsim": MaxSimScorer(self.space),
            "pooled-lsa": PooledLsaScorer(self.lsa, self.doc_ids),
            "bm25": Bm25Scorer(self.bm25, self.doc_ids),
            "oracle": OracleScorer(),
        }
        self._stage_rankings: dict[str, dict[str, list[str]]] = {
            "bm25": {q.query_id: self._ids(self.bm25.rank(q.text)) for q in queries},
            "lsa": {q.query_id: self._ids(self.lsa.rank(q.text)) for q in queries},
        }
        self._stage_rankings["rrf"] = {
            q.query_id: self._ids(
                reciprocal_rank_fusion(
                    [self.bm25.rank(q.text), self.lsa.rank(q.text)]
                )
            )
            for q in queries
        }

    def _ids(self, indices) -> list[str]:
        return [self.doc_ids[i] for i in indices]

    def _evaluate(
        self, name: str, rankings: dict[str, list[str]], latent_dots: float
    ) -> SystemEval:
        per_query = {
            q.query_id: reciprocal_rank(rankings[q.query_id], list(q.relevant), MRR_K)
            for q in self.queries
        }
        by_category = {
            category: mean(
                [per_query[q.query_id] for q in self.queries if q.category == category]
            )
            for category in CATEGORIES
        }
        return SystemEval(
            name=name,
            mrr=mean(list(per_query.values())),
            mrr_by_category=by_category,
            per_query_rr=per_query,
            latent_dots_per_query=latent_dots,
        )

    def run_first_stage(self, stage: str) -> SystemEval:
        # the bi-encoder scan pays one pooled dot per document; rrf pays the
        # same dense scan on top of its (unpriced) bm25 scan; bm25 pays none.
        latent_dots = 0.0 if stage == "bm25" else float(len(self.docs))
        return self._evaluate(stage, self._stage_rankings[stage], latent_dots)

    def run_reranked(self, stage: str, scorer_name: str, depth: int) -> RerankedEval:
        if stage not in FIRST_STAGES:
            raise ValueError(f"unknown first stage {stage!r}")
        if scorer_name not in self.scorers:
            raise ValueError(f"unknown scorer {scorer_name!r}")
        if depth < 1:
            raise ValueError(f"depth must be >= 1, got {depth}")
        scorer = self.scorers[scorer_name]
        first = self.run_first_stage(stage)
        rankings: dict[str, list[str]] = {}
        total_dots = 0
        shortlist_hits: list[float] = []
        for query in self.queries:
            stage_ranking = self._stage_rankings[stage][query.query_id]
            shortlist = stage_ranking[:depth]
            result = rerank(scorer, query, shortlist)
            rankings[query.query_id] = result.ranked_ids + stage_ranking[depth:]
            total_dots += result.latent_dots
            shortlist_hits.append(
                recall_at_k(stage_ranking, list(query.relevant), depth)
            )
        stage_dots = 0.0 if stage == "bm25" else float(len(self.docs))
        system = self._evaluate(
            f"{stage}+{scorer_name}@{depth}",
            rankings,
            stage_dots + total_dots / len(self.queries),
        )
        promoted = sum(
            1
            for q in self.queries
            if system.per_query_rr[q.query_id] > first.per_query_rr[q.query_id]
        )
        demoted = sum(
            1
            for q in self.queries
            if system.per_query_rr[q.query_id] < first.per_query_rr[q.query_id]
        )
        return RerankedEval(
            system=system,
            depth=depth,
            gold_in_shortlist=mean(shortlist_hits),
            promoted=promoted,
            demoted=demoted,
        )

    def compare(self, eval_a: SystemEval, eval_b: SystemEval) -> PairedComparison:
        """Paired bootstrap of a - b over per-query reciprocal ranks."""
        values_a = [eval_a.per_query_rr[q.query_id] for q in self.queries]
        values_b = [eval_b.per_query_rr[q.query_id] for q in self.queries]
        return paired_bootstrap(values_a, values_b)
