"""Banded locality-sensitive hashing over MinHash signatures.

Splitting a k-component signature into b bands of r rows (b*r = k) and
bucketing documents by each band makes two documents candidates when they
agree on every row of at least one band. The probability of that for
Jaccard similarity s is 1 - (1 - s^r)^b, an s-curve whose steep section is
what turns "compare everything to everything" into "verify a short
candidate list".
"""

from __future__ import annotations

from collections import defaultdict


def candidate_pairs(
    signatures: dict[str, tuple[int, ...]], bands: int, rows: int
) -> set[tuple[str, str]]:
    """All unordered id pairs sharing at least one identical band."""
    for doc_id, sig in signatures.items():
        if len(sig) != bands * rows:
            raise ValueError(
                f"signature of {doc_id!r} has {len(sig)} components, "
                f"need bands*rows = {bands * rows}"
            )
    buckets: dict[tuple[int, tuple[int, ...]], list[str]] = defaultdict(list)
    for doc_id, sig in signatures.items():
        for band in range(bands):
            key = (band, sig[band * rows : (band + 1) * rows])
            buckets[key].append(doc_id)
    pairs: set[tuple[str, str]] = set()
    for members in buckets.values():
        if len(members) < 2:
            continue
        members = sorted(members)
        for i, a in enumerate(members):
            for b in members[i + 1 :]:
                pairs.add((a, b))
    return pairs


def collision_probability(similarity: float, bands: int, rows: int) -> float:
    """P(candidate) for a pair at the given Jaccard similarity."""
    if not 0.0 <= similarity <= 1.0:
        raise ValueError(f"similarity must be in [0, 1], got {similarity}")
    return 1.0 - (1.0 - similarity**rows) ** bands


def halfway_threshold(bands: int, rows: int) -> float:
    """The similarity where collision probability crosses 50 percent."""
    return (1.0 - 0.5 ** (1.0 / bands)) ** (1.0 / rows)
