"""Scoring the systems over the golden query set.

Everything is scored on the combined ranking a downstream reader would
consume. Answer metrics ask whether the doc holding the answer surfaced;
pair@5 asks whether both gold docs surfaced in the top 5, which is what a
reader needs to actually justify a two-hop answer rather than guess it.

Drift accounting: for iterative systems each two-hop result records
whether hop 1's top doc was the gold hop-1 doc, and whether the extracted
terms contained every gold bridge token. Conditioning answer rank on those
two bits splits "the extractor was fed the wrong doc" from "the extractor
read the right doc and still pulled the wrong terms" from "the terms were
right and hop-2 ranking failed anyway".
"""

from dataclasses import dataclass

from .data import Query
from .pipeline import Retrieval, iterative, single_shot
from .reuse import (
    BM25Index,
    PairedComparison,
    mean,
    paired_bootstrap,
    reciprocal_rank,
)

RR_K = 10
PAIR_K = 5


@dataclass(frozen=True)
class QueryResult:
    query: Query
    retrieval: Retrieval
    rr: float  # reciprocal rank of the answer doc within top RR_K
    hit1: bool
    hit5: bool
    pair5: bool | None  # two-hop only: both gold docs in top PAIR_K
    hop1_top1_correct: bool | None  # two-hop only
    bridge_hit: bool | None  # two-hop, extracted bridge only


def score(query: Query, retrieval: Retrieval) -> QueryResult:
    ranking = retrieval.ranking
    rr = reciprocal_rank(ranking, [query.answer_id], k=RR_K)
    pair5 = None
    hop1_top1_correct = None
    bridge_hit = None
    if query.kind == "two-hop":
        assert query.hop1_id is not None
        top_pair = set(ranking[:PAIR_K])
        pair5 = query.answer_id in top_pair and query.hop1_id in top_pair
        hop1_top1_correct = (
            bool(retrieval.hop1_ranking) and retrieval.hop1_ranking[0] == query.hop1_id
        )
        if retrieval.bridge_terms:
            bridge_hit = set(query.bridge) <= set(retrieval.bridge_terms)
    return QueryResult(
        query=query,
        retrieval=retrieval,
        rr=rr,
        hit1=bool(ranking) and ranking[0] == query.answer_id,
        hit5=query.answer_id in ranking[:5],
        pair5=pair5,
        hop1_top1_correct=hop1_top1_correct,
        bridge_hit=bridge_hit,
    )


def run_all(
    docs: dict[str, str], queries: list[Query], top_k: int = 10
) -> dict[str, list[QueryResult]]:
    """Run every system over every query it applies to.

    single, iter-append, and iter-focus run blind over all queries, the
    way a production pipeline would: nothing tells it which questions are
    multi-hop. oracle needs the gold bridge, so it only exists for
    two-hop queries.
    """
    index = BM25Index(docs)
    results: dict[str, list[QueryResult]] = {
        "single": [],
        "iter-append": [],
        "iter-focus": [],
        "oracle": [],
    }
    for query in queries:
        results["single"].append(score(query, single_shot(index, query.question, top_k)))
        for name, mode in (("iter-append", "append"), ("iter-focus", "focus")):
            retrieval = iterative(index, docs, query.question, top_k, mode=mode)
            results[name].append(score(query, retrieval))
        if query.kind == "two-hop":
            retrieval = iterative(
                index,
                docs,
                query.question,
                top_k,
                mode="append",
                bridge_override=list(query.bridge),
            )
            results["oracle"].append(score(query, retrieval))
    return results


def two_hop(results: list[QueryResult]) -> list[QueryResult]:
    return [r for r in results if r.query.kind == "two-hop"]


def single_hop(results: list[QueryResult]) -> list[QueryResult]:
    return [r for r in results if r.query.kind == "single-hop"]


@dataclass(frozen=True)
class Aggregate:
    n: int
    recall1: float
    recall5: float
    mrr: float
    pair5: float | None
    search_calls: float


def aggregate(results: list[QueryResult]) -> Aggregate:
    if not results:
        raise ValueError("cannot aggregate zero results")
    pair_flags = [r.pair5 for r in results if r.pair5 is not None]
    return Aggregate(
        n=len(results),
        recall1=mean([float(r.hit1) for r in results]),
        recall5=mean([float(r.hit5) for r in results]),
        mrr=mean([r.rr for r in results]),
        pair5=mean([float(f) for f in pair_flags]) if pair_flags else None,
        search_calls=mean([float(r.retrieval.search_calls) for r in results]),
    )


def drift_split(results: list[QueryResult]) -> dict[str, tuple[int, float]]:
    """Mean answer rr conditioned on what hop 1's top doc actually was.

    Three buckets, because "not the gold hop-1 doc" hides two very
    different events: the answer doc itself outranking the hop-1 doc
    (the question leaked enough attribute vocabulary that no hop was
    needed) versus a genuinely wrong doc feeding the extractor (drift,
    the PRF failure mode). Only defined over two-hop results from an
    iterative system.
    """
    buckets: dict[str, list[float]] = {
        "hop1 top-1 gold": [],
        "hop1 top-1 answer (leak)": [],
        "hop1 top-1 other (drift)": [],
    }
    for r in two_hop(results):
        if r.hop1_top1_correct:
            key = "hop1 top-1 gold"
        elif (
            r.retrieval.hop1_ranking
            and r.retrieval.hop1_ranking[0] == r.query.answer_id
        ):
            key = "hop1 top-1 answer (leak)"
        else:
            key = "hop1 top-1 other (drift)"
        buckets[key].append(r.rr)
    return {
        key: (len(values), mean(values) if values else 0.0)
        for key, values in buckets.items()
    }


def two_hop_rr(
    results: dict[str, list[QueryResult]], name: str
) -> tuple[list[str], list[float]]:
    """Per-query answer rr over the two-hop queries, with their query ids.

    oracle only ever ran on two-hop queries, the rest ran blind over all
    of them; both come back on the same 24 in the same order.
    """
    rows = results[name] if name == "oracle" else two_hop(results[name])
    return [r.query.id for r in rows], [r.rr for r in rows]


def compare_rr(
    results: dict[str, list[QueryResult]], name_a: str, name_b: str
) -> PairedComparison:
    """Paired bootstrap on answer rr, system a minus system b.

    Every system-vs-system gap the readme reasons from goes through here,
    so no ordering gets published as a fact without the interval that says
    whether it survives a resample. The pairing is checked rather than
    assumed: run_all appends in query order, but a paired bootstrap over
    two different query sets is wrong without ever raising.
    """
    ids_a, rr_a = two_hop_rr(results, name_a)
    ids_b, rr_b = two_hop_rr(results, name_b)
    if ids_a != ids_b:
        raise ValueError(
            f"{name_a} and {name_b} scored different queries; cannot pair them"
        )
    return paired_bootstrap(rr_a, rr_b)


def bridge_accuracy(results: list[QueryResult]) -> float:
    """Fraction of two-hop queries whose extracted terms covered the gold bridge."""
    flags = [r.bridge_hit for r in two_hop(results) if r.bridge_hit is not None]
    if not flags:
        raise ValueError("no extracted-bridge results to score")
    return mean([float(f) for f in flags])
