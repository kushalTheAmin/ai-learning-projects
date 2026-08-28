"""The imports from 13 are the same objects 13 uses, not lookalikes."""

import numpy as np

from quantization.reuse import (
    ExactIndex,
    HnswIndex,
    ann_recall,
    clustered_dataset,
    mean,
    uniform_dataset,
)


def test_metric_is_13s_metric():
    import ann.reuse as ann_reuse

    assert ann_recall is ann_reuse.ann_recall
    assert mean is ann_reuse.mean


def test_indexes_are_13s_classes():
    import ann.exact
    import ann.hnsw

    assert ExactIndex is ann.exact.ExactIndex
    assert HnswIndex is ann.hnsw.HnswIndex


def test_datasets_deterministic_given_seed():
    a = clustered_dataset(50, 10, 8, 4, seed=5)
    b = clustered_dataset(50, 10, 8, 4, seed=5)
    assert np.array_equal(a.vectors, b.vectors)
    assert np.array_equal(a.queries, b.queries)
    u1 = uniform_dataset(30, 5, 4, seed=9)
    u2 = uniform_dataset(30, 5, 4, seed=9)
    assert np.array_equal(u1.vectors, u2.vectors)


def test_ann_recall_semantics():
    exact = [(1, 0.0), (2, 0.1), (3, 0.2)]
    assert ann_recall([(1, 0.0), (9, 0.5), (3, 0.3)], exact, 3) == 2 / 3
    assert ann_recall(exact, exact, 3) == 1.0
