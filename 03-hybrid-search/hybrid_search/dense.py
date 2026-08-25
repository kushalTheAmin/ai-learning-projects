"""Dense retriever: latent semantic analysis (TF-IDF + truncated SVD).

This is the classical, fully offline stand-in for a neural embedding model.
SVD compresses the term space into latent dimensions where words that
co-occur across the corpus (kill/terminate/stop, remove/delete/clean) land
close together — which is exactly the property that lets it answer
paraphrased queries BM25 misses. The tradeoff: it only knows words that
appear in the corpus, and compression blurs rare exact identifiers.
"""

import numpy as np
from sklearn.decomposition import TruncatedSVD
from sklearn.feature_extraction.text import TfidfVectorizer

from .tokenize import tokenize

RANDOM_SEED = 42


class DenseLSA:
    def __init__(self, n_components: int = 64):
        self.n_components = n_components
        self._vectorizer: TfidfVectorizer | None = None
        self._svd: TruncatedSVD | None = None
        self._doc_vectors: np.ndarray | None = None

    def fit(self, documents: list[str]) -> "DenseLSA":
        if not documents:
            raise ValueError("DenseLSA requires at least one document")
        self._vectorizer = TfidfVectorizer(
            analyzer=tokenize, sublinear_tf=True, norm="l2"
        )
        tfidf = self._vectorizer.fit_transform(documents)
        n_components = min(self.n_components, len(documents) - 1, tfidf.shape[1] - 1)
        n_components = max(n_components, 1)
        self._svd = TruncatedSVD(n_components=n_components, random_state=RANDOM_SEED)
        vectors = self._svd.fit_transform(tfidf)
        self._doc_vectors = _l2_normalize(vectors)
        return self

    def scores(self, query: str) -> np.ndarray:
        """Cosine similarity of the query against every fitted document.

        A query whose every term is out of vocabulary maps to the zero
        vector and scores 0 everywhere instead of erroring.
        """
        if self._doc_vectors is None:
            raise RuntimeError("call fit() before scores()")
        tfidf = self._vectorizer.transform([query])
        vector = _l2_normalize(self._svd.transform(tfidf))
        return self._doc_vectors @ vector[0]

    def rank(self, query: str) -> np.ndarray:
        s = self.scores(query)
        return np.argsort(-s, kind="stable")


def _l2_normalize(vectors: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    norms[norms == 0.0] = 1.0
    return vectors / norms
