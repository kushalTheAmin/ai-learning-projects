"""64-bit SimHash fingerprints.

Each shingle votes +1 or -1 on every bit position according to its own
64-bit hash; the fingerprint keeps the sign of each bit's total. Similar
shingle sets produce fingerprints at small Hamming distance, so "near
duplicate" becomes "Hamming distance at most d" on fixed-size integers,
which is what makes SimHash attractive for indexing at scale.
"""

from __future__ import annotations

from .shingles import hash_shingle

BITS = 64


def simhash(shingles: set[str]) -> int:
    """Fingerprint of a shingle set. The empty set maps to 0."""
    if not shingles:
        return 0
    totals = [0] * BITS
    for shingle in shingles:
        h = hash_shingle(shingle)
        for bit in range(BITS):
            if (h >> bit) & 1:
                totals[bit] += 1
            else:
                totals[bit] -= 1
    fingerprint = 0
    for bit in range(BITS):
        if totals[bit] > 0:
            fingerprint |= 1 << bit
    return fingerprint


def hamming_distance(a: int, b: int) -> int:
    return (a ^ b).bit_count()
