"""MinHash signatures for Jaccard estimation.

Each hash function is a random affine map h(x) = (a*x + b) mod p over a
Mersenne prime, applied to the 64-bit shingle hashes. The minimum of h over
a set is equal between two sets with probability exactly their Jaccard
similarity, so the fraction of matching signature components is an unbiased
estimate of it, with standard error about sqrt(j*(1-j)/k) for k components.

Signatures are prefix-truncatable: the first k components of a larger
signature are exactly the signature the first k hash functions would have
produced, so one pass at the largest k serves a whole accuracy sweep.
"""

from __future__ import annotations

import random

MERSENNE_P = (1 << 61) - 1

# Sentinel component for the empty shingle set. It is >= MERSENNE_P, which
# (a*x + b) mod p can never produce, so an empty document matches another
# empty document on every component and a non-empty one on none.
EMPTY_SENTINEL = MERSENNE_P


class MinHasher:
    """A fixed family of num_hashes seeded hash functions."""

    def __init__(self, num_hashes: int, seed: int) -> None:
        if num_hashes < 1:
            raise ValueError(f"num_hashes must be >= 1, got {num_hashes}")
        self.num_hashes = num_hashes
        rng = random.Random(seed)
        self._params = [
            (rng.randrange(1, MERSENNE_P), rng.randrange(0, MERSENNE_P))
            for _ in range(num_hashes)
        ]

    def signature(self, shingle_hashes: set[int]) -> tuple[int, ...]:
        if not shingle_hashes:
            return (EMPTY_SENTINEL,) * self.num_hashes
        return tuple(
            min((a * x + b) % MERSENNE_P for x in shingle_hashes)
            for a, b in self._params
        )


def estimate_jaccard(
    sig_a: tuple[int, ...], sig_b: tuple[int, ...], k: int | None = None
) -> float:
    """Fraction of matching components over the first k (default: all)."""
    if len(sig_a) != len(sig_b):
        raise ValueError(f"signature lengths differ: {len(sig_a)} vs {len(sig_b)}")
    if k is None:
        k = len(sig_a)
    if not 1 <= k <= len(sig_a):
        raise ValueError(f"k must be in [1, {len(sig_a)}], got {k}")
    matches = sum(1 for x, y in zip(sig_a[:k], sig_b[:k]) if x == y)
    return matches / k
