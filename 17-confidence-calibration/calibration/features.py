"""Bag-of-words features over 02's tokenizer.

The vocabulary is built from training text only; tokens the training
set never saw are dropped at vectorize time, exactly what a deployed
count vectorizer does to drifted vocabulary.
"""

import numpy as np

from calibration.reuse import tokenize


def build_vocabulary(texts: list[str]) -> dict[str, int]:
    seen: set[str] = set()
    for text in texts:
        seen.update(tokenize(text))
    return {token: idx for idx, token in enumerate(sorted(seen))}


def vectorize(texts: list[str], vocabulary: dict[str, int]) -> np.ndarray:
    """Token-count matrix, one row per text, unknown tokens dropped."""
    if not vocabulary:
        raise ValueError("vocabulary is empty")
    matrix = np.zeros((len(texts), len(vocabulary)), dtype=np.float64)
    for row, text in enumerate(texts):
        for token in tokenize(text):
            col = vocabulary.get(token)
            if col is not None:
                matrix[row, col] += 1.0
    return matrix
