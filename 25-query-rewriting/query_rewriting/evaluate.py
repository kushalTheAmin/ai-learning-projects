"""Runs every rewriting system over the golden set and scores it.

All systems share one BM25 index and one metric stack (02's). A system is
just a rule for producing the search string, so any measured difference is
attributable to the rewrite alone.
"""

from dataclasses import dataclass

from .data import Query
from .generator import GENERIC_ANSWER, ScriptedHyde
from .reuse import BM25Index, mean, recall_at_k, reciprocal_rank, tokenize
from .rewrite import hyde_append, hyde_replace, prf_expand, raw

MRR_K = 10


@dataclass(frozen=True)
class QueryOutcome:
    query_id: str
    category: str
    rr: float
    recall1: float
    recall5: float
    added_terms: int  # distinct tokens in the search string beyond the raw query's
    hallucinated: bool | None = None  # hyde systems only
    prf_source_relevant: bool | None = None  # prf only: expansion doc was a gold doc


@dataclass(frozen=True)
class Aggregate:
    n: int
    recall1: float
    recall5: float
    mrr: float
    added_terms: float


def _score(
    index: BM25Index,
    query: Query,
    search_text: str,
    hallucinated: bool | None = None,
    prf_source_relevant: bool | None = None,
) -> QueryOutcome:
    ranked = [doc_id for doc_id, _ in index.search(search_text, top_k=MRR_K)]
    relevant = list(query.relevant)
    added = len(set(tokenize(search_text)) - set(tokenize(query.text)))
    return QueryOutcome(
        query_id=query.query_id,
        category=query.category,
        rr=reciprocal_rank(ranked, relevant, MRR_K),
        recall1=recall_at_k(ranked, relevant, 1),
        recall5=recall_at_k(ranked, relevant, 5),
        added_terms=added,
        hallucinated=hallucinated,
        prf_source_relevant=prf_source_relevant,
    )


def run_raw(index: BM25Index, queries: list[Query]) -> list[QueryOutcome]:
    return [_score(index, query, raw(query)) for query in queries]


def run_prf(
    docs: dict[str, str],
    index: BM25Index,
    queries: list[Query],
    max_terms: int,
) -> list[QueryOutcome]:
    outcomes = []
    for query in queries:
        search_text, source_id = prf_expand(query, docs, index, max_terms)
        source_relevant = source_id in query.relevant if source_id is not None else None
        outcomes.append(_score(index, query, search_text, prf_source_relevant=source_relevant))
    return outcomes


def run_hyde(
    index: BM25Index,
    queries: list[Query],
    hyde: ScriptedHyde,
    mode: str,
) -> list[QueryOutcome]:
    if mode not in ("append", "replace"):
        raise ValueError(f"mode must be 'append' or 'replace', got {mode!r}")
    rewriter = hyde_append if mode == "append" else hyde_replace
    return [
        _score(
            index,
            query,
            rewriter(query, hyde),
            hallucinated=hyde.generate(query.query_id).hallucinated,
        )
        for query in queries
    ]


def run_generic_append(index: BM25Index, queries: list[Query]) -> list[QueryOutcome]:
    """The weak-model floor: a fluent answer with no subject knowledge,
    appended to every query."""
    return [
        _score(index, query, f"{query.text} {GENERIC_ANSWER}") for query in queries
    ]


def aggregate(outcomes: list[QueryOutcome]) -> Aggregate:
    if not outcomes:
        raise ValueError("cannot aggregate zero query outcomes")
    return Aggregate(
        n=len(outcomes),
        recall1=mean([outcome.recall1 for outcome in outcomes]),
        recall5=mean([outcome.recall5 for outcome in outcomes]),
        mrr=mean([outcome.rr for outcome in outcomes]),
        added_terms=mean([float(outcome.added_terms) for outcome in outcomes]),
    )


def by_category(outcomes: list[QueryOutcome], category: str) -> list[QueryOutcome]:
    return [outcome for outcome in outcomes if outcome.category == category]


def paired_rrs(
    outcomes_a: list[QueryOutcome], outcomes_b: list[QueryOutcome]
) -> tuple[list[float], list[float]]:
    """Per-query reciprocal ranks aligned by query id, for the paired
    bootstrap. Raises if the two runs scored different query sets."""
    rr_a = {outcome.query_id: outcome.rr for outcome in outcomes_a}
    rr_b = {outcome.query_id: outcome.rr for outcome in outcomes_b}
    if set(rr_a) != set(rr_b):
        raise ValueError("paired runs must score the same query set")
    ids = sorted(rr_a)
    return [rr_a[i] for i in ids], [rr_b[i] for i in ids]
