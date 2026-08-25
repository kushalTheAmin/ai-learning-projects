"""Okapi BM25, implemented from scratch on top of the shared tokenizer."""

import math
from collections import Counter

import numpy as np

from .tokenize import tokenize


class BM25:
    """Classic Okapi BM25 with the +1 idf smoothing used by Lucene.

    k1 controls term-frequency saturation, b controls document-length
    normalization.
    """

    def __init__(self, k1: float = 1.5, b: float = 0.75):
        self.k1 = k1
        self.b = b
        self._doc_term_freqs: list[Counter] = []
        self._doc_lens: np.ndarray | None = None
        self._avg_doc_len = 0.0
        self._idf: dict[str, float] = {}

    def fit(self, documents: list[str]) -> "BM25":
        if not documents:
            raise ValueError("BM25 requires at least one document")
        self._doc_term_freqs = [Counter(tokenize(doc)) for doc in documents]
        self._doc_lens = np.array(
            [sum(tf.values()) for tf in self._doc_term_freqs], dtype=float
        )
        self._avg_doc_len = float(self._doc_lens.mean()) or 1.0
        n = len(documents)
        doc_freq: Counter = Counter()
        for tf in self._doc_term_freqs:
            doc_freq.update(tf.keys())
        self._idf = {
            term: math.log((n - df + 0.5) / (df + 0.5) + 1.0)
            for term, df in doc_freq.items()
        }
        return self

    def scores(self, query: str) -> np.ndarray:
        """BM25 score of the query against every fitted document."""
        if self._doc_lens is None:
            raise RuntimeError("call fit() before scores()")
        result = np.zeros(len(self._doc_term_freqs))
        norm = 1.0 - self.b + self.b * (self._doc_lens / self._avg_doc_len)
        # unique query terms only: a repeated term must not score double.
        # same semantics as 02-retrieval-eval's BM25Index, pinned by test.
        for term in dict.fromkeys(tokenize(query)):
            idf = self._idf.get(term)
            if idf is None:
                continue
            tf = np.array([dtf.get(term, 0) for dtf in self._doc_term_freqs], dtype=float)
            result += idf * (tf * (self.k1 + 1.0)) / (tf + self.k1 * norm)
        return result

    def rank(self, query: str) -> np.ndarray:
        """Document indices sorted best-first (stable for ties)."""
        s = self.scores(query)
        return np.argsort(-s, kind="stable")
