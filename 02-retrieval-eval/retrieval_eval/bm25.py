import math
from collections import Counter

from .tokenizer import tokenize


class BM25Index:
    """Okapi BM25 with the non-negative idf variant Lucene uses:
    log(1 + (N - df + 0.5) / (df + 0.5)).

    k1 controls term-frequency saturation (higher = repeats keep paying off),
    b controls document-length normalization (0 = off, 1 = full).
    """

    def __init__(self, docs: dict[str, str], k1: float = 1.5, b: float = 0.75):
        if not 0 <= b <= 1:
            raise ValueError(f"b must be in [0, 1], got {b}")
        if k1 < 0:
            raise ValueError(f"k1 must be non-negative, got {k1}")
        self.k1 = k1
        self.b = b
        self.doc_ids = list(docs)
        self.term_counts = [Counter(tokenize(text)) for text in docs.values()]
        self.doc_lengths = [sum(counts.values()) for counts in self.term_counts]
        n = len(self.doc_ids)
        self.avg_doc_length = (sum(self.doc_lengths) / n) if n else 0.0
        df: Counter = Counter()
        for counts in self.term_counts:
            df.update(counts.keys())
        self.idf = {
            term: math.log(1 + (n - d + 0.5) / (d + 0.5)) for term, d in df.items()
        }

    def search(self, query: str, top_k: int = 10) -> list[tuple[str, float]]:
        scores = [0.0] * len(self.doc_ids)
        for term in dict.fromkeys(tokenize(query)):  # unique, order preserved
            idf = self.idf.get(term)
            if idf is None:
                continue
            for i, counts in enumerate(self.term_counts):
                tf = counts.get(term, 0)
                if tf == 0:
                    continue
                length_norm = 1 - self.b + self.b * self.doc_lengths[i] / self.avg_doc_length
                scores[i] += idf * tf * (self.k1 + 1) / (tf + self.k1 * length_norm)
        ranked = sorted(zip(self.doc_ids, scores), key=lambda pair: (-pair[1], pair[0]))
        return [(doc_id, score) for doc_id, score in ranked[:top_k] if score > 0]
