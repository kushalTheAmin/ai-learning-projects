import math
from collections import Counter

from .tokenizer import tokenize


class TfidfIndex:
    """TF-IDF retrieval with cosine similarity.

    Raw term frequency, smoothed idf (log((1+N)/(1+df)) + 1), l2-normalized
    document vectors — the same weighting scheme sklearn's TfidfVectorizer
    uses by default.
    """

    def __init__(self, docs: dict[str, str]):
        self.doc_ids = list(docs)
        term_counts = [Counter(tokenize(text)) for text in docs.values()]
        n = len(term_counts)
        df: Counter = Counter()
        for counts in term_counts:
            df.update(counts.keys())
        self.idf = {term: math.log((1 + n) / (1 + d)) + 1 for term, d in df.items()}
        self.doc_vectors = [self._vectorize(counts) for counts in term_counts]

    def _vectorize(self, counts: Counter) -> dict[str, float]:
        vector = {term: count * self.idf[term] for term, count in counts.items()}
        norm = math.sqrt(sum(weight * weight for weight in vector.values()))
        if norm == 0:
            return {}
        return {term: weight / norm for term, weight in vector.items()}

    def search(self, query: str, top_k: int = 10) -> list[tuple[str, float]]:
        # terms never seen at index time have no idf, mirroring a fitted
        # vectorizer — they contribute nothing to the score
        query_vector = {
            term: count * self.idf[term]
            for term, count in Counter(tokenize(query)).items()
            if term in self.idf
        }
        norm = math.sqrt(sum(weight * weight for weight in query_vector.values()))
        if norm == 0:
            return []
        query_vector = {term: weight / norm for term, weight in query_vector.items()}

        scores = [
            sum(query_vector.get(term, 0.0) * weight for term, weight in doc_vector.items())
            for doc_vector in self.doc_vectors
        ]
        ranked = sorted(zip(self.doc_ids, scores), key=lambda pair: (-pair[1], pair[0]))
        return [(doc_id, score) for doc_id, score in ranked[:top_k] if score > 0]
