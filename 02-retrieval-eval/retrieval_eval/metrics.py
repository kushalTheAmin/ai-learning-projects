def recall_at_k(ranked_ids: list[str], relevant_ids: list[str], k: int) -> float:
    """Fraction of the relevant set that appears in the top k results."""
    if k < 1:
        raise ValueError(f"k must be >= 1, got {k}")
    relevant = set(relevant_ids)
    if not relevant:
        raise ValueError("relevant_ids must be non-empty")
    hits = len(set(ranked_ids[:k]) & relevant)
    return hits / len(relevant)


def reciprocal_rank(ranked_ids: list[str], relevant_ids: list[str], k: int) -> float:
    """1 / rank of the first relevant result within the top k, else 0."""
    if k < 1:
        raise ValueError(f"k must be >= 1, got {k}")
    relevant = set(relevant_ids)
    if not relevant:
        raise ValueError("relevant_ids must be non-empty")
    for rank, doc_id in enumerate(ranked_ids[:k], start=1):
        if doc_id in relevant:
            return 1.0 / rank
    return 0.0


def mean(values: list[float]) -> float:
    if not values:
        raise ValueError("cannot take the mean of an empty list")
    return sum(values) / len(values)
