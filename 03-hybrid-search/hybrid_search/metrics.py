"""Retrieval-quality metrics: recall@k and mean reciprocal rank."""


def recall_at_k(retrieved_ids: list[str], relevant_ids: set[str], k: int) -> float:
    """Fraction of the relevant documents that appear in the top k."""
    if k <= 0:
        raise ValueError(f"k must be positive, got {k}")
    if not relevant_ids:
        raise ValueError("relevant_ids must not be empty")
    hits = sum(1 for doc_id in retrieved_ids[:k] if doc_id in relevant_ids)
    return hits / len(relevant_ids)


def reciprocal_rank(retrieved_ids: list[str], relevant_ids: set[str], k: int) -> float:
    """1 / rank of the first relevant document within the top k, else 0.

    The cutoff is required, not optional: the rankings this is scored over
    cover the whole corpus, so without one every query would find its answer
    somewhere and the metric could never come out 0. Same semantics as
    02-retrieval-eval's reciprocal_rank, pinned by a test in each project.
    """
    if k <= 0:
        raise ValueError(f"k must be positive, got {k}")
    if not relevant_ids:
        raise ValueError("relevant_ids must not be empty")
    for position, doc_id in enumerate(retrieved_ids[:k], start=1):
        if doc_id in relevant_ids:
            return 1.0 / position
    return 0.0


def mean(values: list[float]) -> float:
    if not values:
        raise ValueError("cannot average an empty list")
    return sum(values) / len(values)
