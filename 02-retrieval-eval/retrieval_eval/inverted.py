import heapq
import math
from collections import Counter
from dataclasses import dataclass

from .tokenizer import tokenize


@dataclass
class SearchStats:
    """Work done by one search call, counted exactly.

    postings_touched: (term, doc) pairs read from posting lists
    candidates: distinct docs that held at least one query term
    terms_matched: query terms present in the index vocabulary
    """

    postings_touched: int
    candidates: int
    terms_matched: int


class InvertedBM25Index:
    """The same Okapi BM25 as BM25Index, served from an inverted index.

    Instead of per-doc term counts scanned in full per query term, the
    corpus is stored as posting lists: term -> [(doc_index, tf), ...] in
    ascending doc order. A query touches only the postings of its own
    terms, accumulates scores term-at-a-time in the same order the flat
    scan would, and heap-selects top_k from the candidate set. Rankings
    and scores are bit-identical to BM25Index by construction; the tests
    pin that with exact float equality.
    """

    def __init__(self, docs: dict[str, str], k1: float = 1.5, b: float = 0.75):
        if not 0 <= b <= 1:
            raise ValueError(f"b must be in [0, 1], got {b}")
        if k1 < 0:
            raise ValueError(f"k1 must be non-negative, got {k1}")
        self.k1 = k1
        self.b = b
        self.doc_ids = list(docs)
        self.postings: dict[str, list[tuple[int, int]]] = {}
        self.doc_lengths: list[int] = []
        for i, text in enumerate(docs.values()):
            counts = Counter(tokenize(text))
            self.doc_lengths.append(sum(counts.values()))
            for term, tf in counts.items():
                self.postings.setdefault(term, []).append((i, tf))
        n = len(self.doc_ids)
        self.avg_doc_length = (sum(self.doc_lengths) / n) if n else 0.0
        self.idf = {
            term: math.log(1 + (n - len(plist) + 0.5) / (len(plist) + 0.5))
            for term, plist in self.postings.items()
        }
        # precomputed once per doc; the flat scan recomputes this exact
        # expression per (term, doc), same value either way
        self.length_norms = [
            1 - self.b + self.b * length / self.avg_doc_length
            for length in self.doc_lengths
        ]

    def search(self, query: str, top_k: int = 10) -> list[tuple[str, float]]:
        results, _ = self.search_with_stats(query, top_k)
        return results

    def search_with_stats(
        self, query: str, top_k: int = 10
    ) -> tuple[list[tuple[str, float]], SearchStats]:
        scores: dict[int, float] = {}
        postings_touched = 0
        terms_matched = 0
        for term in dict.fromkeys(tokenize(query)):  # unique, order preserved
            plist = self.postings.get(term)
            if plist is None:
                continue
            terms_matched += 1
            postings_touched += len(plist)
            idf = self.idf[term]
            k1 = self.k1
            for i, tf in plist:
                gain = idf * tf * (k1 + 1) / (tf + k1 * self.length_norms[i])
                scores[i] = scores.get(i, 0.0) + gain
        top = heapq.nsmallest(
            top_k,
            scores.items(),
            key=lambda item: (-item[1], self.doc_ids[item[0]]),
        )
        results = [(self.doc_ids[i], score) for i, score in top]
        stats = SearchStats(
            postings_touched=postings_touched,
            candidates=len(scores),
            terms_matched=terms_matched,
        )
        return results, stats
