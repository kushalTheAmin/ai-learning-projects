"""Rerank scorers and the shortlist reordering they drive.

A reranker is a scorer too expensive (or too privileged) to run over the
whole corpus, applied to the first stage's shortlist. Four scorers cover
the space this project measures:

- MaxSimScorer: late interaction over per-term LSA vectors, cost
  |query terms| x |doc terms| latent dot products per pair
- PooledLsaScorer: the bi-encoder's own pooled cosine, cost one latent dot
  per candidate (doc vectors are precomputed; the query is encoded once)
- Bm25Scorer: the lexical score as a reranker, zero latent dots (postings
  work is a different currency)
- OracleScorer: reads the relevance labels and puts gold first; it prices
  the shortlist ceiling, i.e. what a perfect cross-encoder could get

Every scorer returns (scores by doc id, latent dots spent), and rerank()
sorts stably so candidates a scorer cannot separate keep first-stage order.
"""

from dataclasses import dataclass
from typing import Protocol

import numpy as np

from .data import Query
from .reuse import BM25, DenseLSA
from .term_space import TermSpace


@dataclass(frozen=True)
class RerankResult:
    ranked_ids: list[str]  # candidates best-first; ties keep first-stage order
    scores: dict[str, float]
    latent_dots: int


class Scorer(Protocol):
    name: str

    def score(
        self, query: Query, candidate_ids: list[str]
    ) -> tuple[dict[str, float], int]: ...


class MaxSimScorer:
    """Idf-weighted mean over query terms of max cosine to any doc term.

    A query with no in-vocabulary terms, or a doc with no in-vocabulary
    terms, scores 0.0 at zero cost: the space knows nothing about either
    side, so the scorer must not reorder on it. An exact term match
    contributes cosine 1.0, so a doc containing every query term scores
    exactly 1.0.
    """

    name = "maxsim"

    def __init__(self, space: TermSpace):
        self._space = space

    def score(
        self, query: Query, candidate_ids: list[str]
    ) -> tuple[dict[str, float], int]:
        space = self._space
        query_indices = space.term_indices(query.text)
        scores: dict[str, float] = {}
        total_dots = 0
        for doc_id in candidate_ids:
            doc_indices = space.profiles[doc_id].term_indices
            if len(query_indices) == 0 or len(doc_indices) == 0:
                scores[doc_id] = 0.0
                continue
            sims = space.term_vectors[query_indices] @ space.term_vectors[doc_indices].T
            weights = space.idf[query_indices]
            scores[doc_id] = float(
                (weights * sims.max(axis=1)).sum() / weights.sum()
            )
            total_dots += sims.size
        return scores, total_dots


class PooledLsaScorer:
    """The bi-encoder's own pooled cosine, restricted to the candidates.

    Reads the fitted DenseLSA's internals (same pattern as TermSpace) so it
    can dot the query against candidate vectors only, which is what a
    production reranker with a stored vector table pays: one latent dot per
    candidate plus one query encode. A test pins these scores to
    DenseLSA.scores() to float noise, so this path cannot drift from 03's.
    """

    name = "pooled-lsa"

    def __init__(self, lsa: DenseLSA, doc_ids: list[str]):
        if lsa._vectorizer is None or lsa._svd is None or lsa._doc_vectors is None:
            raise ValueError("PooledLsaScorer requires a fitted DenseLSA")
        self._lsa = lsa
        self._row = {doc_id: i for i, doc_id in enumerate(doc_ids)}
        if len(self._row) != len(doc_ids):
            raise ValueError("doc_ids must be unique")

    def score(
        self, query: Query, candidate_ids: list[str]
    ) -> tuple[dict[str, float], int]:
        lsa = self._lsa
        tfidf = lsa._vectorizer.transform([query.text])
        vector = lsa._svd.transform(tfidf)[0]
        norm = np.linalg.norm(vector)
        if norm > 0.0:
            vector = vector / norm
        rows = np.array([self._row[doc_id] for doc_id in candidate_ids], dtype=int)
        dots = lsa._doc_vectors[rows] @ vector if len(rows) else np.zeros(0)
        return (
            {doc_id: float(s) for doc_id, s in zip(candidate_ids, dots)},
            len(candidate_ids),
        )


class Bm25Scorer:
    """BM25 as a reranker over someone else's shortlist."""

    name = "bm25"

    def __init__(self, bm25: BM25, doc_ids: list[str]):
        self._bm25 = bm25
        self._row = {doc_id: i for i, doc_id in enumerate(doc_ids)}
        if len(self._row) != len(doc_ids):
            raise ValueError("doc_ids must be unique")

    def score(
        self, query: Query, candidate_ids: list[str]
    ) -> tuple[dict[str, float], int]:
        all_scores = self._bm25.scores(query.text)
        return (
            {doc_id: float(all_scores[self._row[doc_id]]) for doc_id in candidate_ids},
            0,
        )


class OracleScorer:
    """Puts relevant docs first. This is label leakage on purpose: it is the
    best any reranker could do on this shortlist, so the gap between it and
    a real scorer is scorer headroom, while its own gap below mrr 1.0 is
    the first stage's ceiling that no reranker can cross."""

    name = "oracle"

    def score(
        self, query: Query, candidate_ids: list[str]
    ) -> tuple[dict[str, float], int]:
        relevant = set(query.relevant)
        return {d: 1.0 if d in relevant else 0.0 for d in candidate_ids}, 0


def rerank(scorer: Scorer, query: Query, candidate_ids: list[str]) -> RerankResult:
    if len(set(candidate_ids)) != len(candidate_ids):
        raise ValueError("candidate_ids must be unique")
    scores, latent_dots = scorer.score(query, candidate_ids)
    ranked = sorted(candidate_ids, key=lambda doc_id: -scores[doc_id])
    return RerankResult(ranked_ids=ranked, scores=scores, latent_dots=latent_dots)
