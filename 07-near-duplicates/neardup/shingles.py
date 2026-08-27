"""Text normalization and word-shingle extraction.

Shingles are the unit every detector in this project works on: a document
becomes the set of its word n-grams, and similarity between documents is
similarity between those sets.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata

WORD_RE = re.compile(r"[^\W_]+", re.UNICODE)

# Note: WORD_RE treats any run of word characters as one token, so scripts
# written without spaces (CJK) come out as whole-run tokens. The committed
# corpus is English; this limitation is pinned by a test, not hidden.


def normalize(text: str) -> str:
    """NFKC-fold, casefold, and collapse whitespace."""
    folded = unicodedata.normalize("NFKC", text).casefold()
    return " ".join(folded.split())


def tokenize(text: str) -> list[str]:
    return WORD_RE.findall(normalize(text))


def word_shingles(text: str, n: int = 3) -> set[str]:
    """The set of n-word shingles of the normalized text.

    A document with fewer than n words (but at least one) yields a single
    shingle covering all of its words, so short documents still compare.
    """
    if n < 1:
        raise ValueError(f"shingle size must be >= 1, got {n}")
    tokens = tokenize(text)
    if not tokens:
        return set()
    if len(tokens) < n:
        return {" ".join(tokens)}
    return {" ".join(tokens[i : i + n]) for i in range(len(tokens) - n + 1)}


def hash_shingle(shingle: str) -> int:
    """Stable 64-bit hash of a shingle, identical across runs and machines."""
    digest = hashlib.blake2b(shingle.encode("utf-8"), digest_size=8).digest()
    return int.from_bytes(digest, "big")


def hashed_shingles(text: str, n: int = 3) -> set[int]:
    return {hash_shingle(s) for s in word_shingles(text, n)}


def jaccard(a: set, b: set) -> float:
    """Exact Jaccard similarity. Two empty sets are identical, so 1.0."""
    if not a and not b:
        return 1.0
    return len(a & b) / len(a | b)
