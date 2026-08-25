from dataclasses import dataclass
from typing import Protocol

from .data import Query
from .metrics import mean, recall_at_k, reciprocal_rank


class Retriever(Protocol):
    def search(self, query: str, top_k: int) -> list[tuple[str, float]]: ...


@dataclass(frozen=True)
class QueryOutcome:
    query: Query
    ranked_ids: tuple[str, ...]
    reciprocal_rank: float
    recall_at: dict[int, float]


@dataclass(frozen=True)
class SystemReport:
    name: str
    recall_at: dict[int, float]
    mrr: float
    outcomes: tuple[QueryOutcome, ...]


@dataclass(frozen=True)
class HeadToHead:
    wins_a: tuple[str, ...]
    wins_b: tuple[str, ...]
    ties: int


def evaluate_system(
    name: str,
    index: Retriever,
    queries: list[Query],
    k_values: tuple[int, ...] = (1, 5),
    mrr_k: int = 10,
) -> SystemReport:
    depth = max(*k_values, mrr_k)
    outcomes = []
    for query in queries:
        ranked_ids = tuple(doc_id for doc_id, _ in index.search(query.text, top_k=depth))
        outcomes.append(
            QueryOutcome(
                query=query,
                ranked_ids=ranked_ids,
                reciprocal_rank=reciprocal_rank(list(ranked_ids), list(query.relevant), mrr_k),
                recall_at={
                    k: recall_at_k(list(ranked_ids), list(query.relevant), k) for k in k_values
                },
            )
        )
    return SystemReport(
        name=name,
        recall_at={k: mean([o.recall_at[k] for o in outcomes]) for k in k_values},
        mrr=mean([o.reciprocal_rank for o in outcomes]),
        outcomes=tuple(outcomes),
    )


def head_to_head(report_a: SystemReport, report_b: SystemReport) -> HeadToHead:
    """Per-query win/loss/tie between two systems, judged by reciprocal rank."""
    wins_a, wins_b, ties = [], [], 0
    for outcome_a, outcome_b in zip(report_a.outcomes, report_b.outcomes):
        if outcome_a.query != outcome_b.query:
            raise ValueError("reports were built from different query lists")
        if outcome_a.reciprocal_rank > outcome_b.reciprocal_rank:
            wins_a.append(outcome_a.query.text)
        elif outcome_b.reciprocal_rank > outcome_a.reciprocal_rank:
            wins_b.append(outcome_b.query.text)
        else:
            ties += 1
    return HeadToHead(wins_a=tuple(wins_a), wins_b=tuple(wins_b), ties=ties)
