"""Per-term vectors read out of 03's fitted LSA model, plus per-doc term profiles.

The bi-encoder (03's DenseLSA) pools a whole document into one vector before
any query arrives, so all the query ever meets is the pooled average. This
module recovers the representation underneath that pooling: one latent
vector per vocabulary term, taken from the same fitted TF-IDF + SVD model.
A single-term document maps under LSA to its row of V (the SVD's term
factor), so the term vectors ARE the coordinates DenseLSA itself would give
one-term inputs; nothing is refit and no second embedding space exists.

TermSpace deliberately reads the fitted internals of a DenseLSA instance
rather than fitting its own — same pattern as 21 subclassing 13's HNSW. If
it refit, the comparison would be between two different spaces and any
measured gap could be fit noise instead of architecture.
"""

from dataclasses import dataclass

import numpy as np

from .reuse import DenseLSA, tokenize


@dataclass(frozen=True)
class DocProfile:
    """Unique in-vocabulary terms of one document, as term-vector row indices."""

    doc_id: str
    term_indices: np.ndarray  # shape (m,), int — rows into TermSpace.term_vectors


def _unit_rows(matrix: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms[norms == 0.0] = 1.0
    return matrix / norms


class TermSpace:
    """Term vectors, idf weights and doc term profiles over a fitted DenseLSA."""

    def __init__(self, lsa: DenseLSA, doc_ids: list[str], doc_texts: list[str]):
        vectorizer = lsa._vectorizer
        svd = lsa._svd
        if vectorizer is None or svd is None:
            raise ValueError("TermSpace requires a fitted DenseLSA")
        if len(doc_ids) != len(doc_texts):
            raise ValueError(
                f"got {len(doc_ids)} doc ids for {len(doc_texts)} texts"
            )
        self.vocab: dict[str, int] = dict(vectorizer.vocabulary_)
        # svd.transform(X) is X @ components_.T, so the identity matrix over
        # the vocabulary maps to components_.T: row j is term j's latent
        # coordinates, exactly what DenseLSA gives a one-term document
        # (tf-idf scaling is a positive scalar per term and dies in the
        # normalization).
        self.term_vectors: np.ndarray = _unit_rows(np.asarray(svd.components_).T.copy())
        self.idf: np.ndarray = np.asarray(vectorizer.idf_, dtype=float)
        self.profiles: dict[str, DocProfile] = {}
        for doc_id, text in zip(doc_ids, doc_texts):
            if doc_id in self.profiles:
                raise ValueError(f"duplicate doc id {doc_id!r}")
            self.profiles[doc_id] = DocProfile(
                doc_id=doc_id, term_indices=self.term_indices(text)
            )

    def term_indices(self, text: str) -> np.ndarray:
        """Unique in-vocabulary term indices of `text`, in first-seen order.

        Repeated terms count once (same semantics as 02's and 03's BM25) and
        out-of-vocabulary terms are dropped: the space has no vector for them.
        """
        indices = [
            self.vocab[token]
            for token in dict.fromkeys(tokenize(text))
            if token in self.vocab
        ]
        return np.array(indices, dtype=int)
