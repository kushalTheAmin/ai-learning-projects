"""Retrieval-quality metrics: recall@k and mean reciprocal rank."""


def recall_at_k(retrieved_ids: list[str], relevant_ids: set[str], k: int) -> float:
    """Fraction of the relevant documents that appear in the top k."""
    if k <= 0:
        raise ValueError(f"k must be positive, got {k}")
    if not relevant_ids:
        raise ValueError("relevant_ids must not be empty")
    hits = sum(1 for doc_id in retrieved_ids[:k] if doc_id in relevant_ids)
    return hits / len(relevant_ids)


def reciprocal_rank(retrieved_ids: list[str], relevant_ids: set[str]) -> float:
    """1 / rank of the first relevant document, 0 if none was retrieved."""
    if not relevant_ids:
        raise ValueError("relevant_ids must not be empty")
    for position, doc_id in enumerate(retrieved_ids, start=1):
        if doc_id in relevant_ids:
            return 1.0 / position
    return 0.0


def mean(values: list[float]) -> float:
    if not values:
        raise ValueError("cannot average an empty list")
    return sum(values) / len(values)
