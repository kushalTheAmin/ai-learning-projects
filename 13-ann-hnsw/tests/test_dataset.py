import numpy as np
import pytest

from ann.dataset import Dataset, clustered_dataset, uniform_dataset


def test_shapes_and_determinism() -> None:
    a = clustered_dataset(100, 20, 8, 5, seed=1)
    b = clustered_dataset(100, 20, 8, 5, seed=1)
    assert a.vectors.shape == (100, 8)
    assert a.queries.shape == (20, 8)
    assert np.array_equal(a.vectors, b.vectors)
    assert np.array_equal(a.queries, b.queries)


def test_different_seeds_differ() -> None:
    a = clustered_dataset(50, 10, 4, 3, seed=1)
    b = clustered_dataset(50, 10, 4, 3, seed=2)
    assert not np.array_equal(a.vectors, b.vectors)


def test_uniform_dataset_stays_in_unit_cube() -> None:
    data = uniform_dataset(200, 20, 6, seed=3)
    assert data.vectors.min() >= 0.0 and data.vectors.max() <= 1.0
    assert data.queries.shape == (20, 6)


def test_outlier_fraction_is_respected() -> None:
    data = clustered_dataset(50, 100, 4, 3, seed=5, cluster_std=0.01, outlier_fraction=0.1)
    assert data.queries.shape == (100, 4)
    # the last 10 rows are uniform draws, not cluster members; with std 0.01
    # a cluster member sits within ~0.04 of a center, a uniform draw almost
    # surely does not
    centers_dist = np.min(
        np.linalg.norm(data.queries[:, None, :] - data.vectors[None, :, :], axis=2), axis=1
    )
    assert np.median(centers_dist[:90]) < 0.1 < np.median(centers_dist[90:])


def test_rejects_bad_shapes_and_params() -> None:
    with pytest.raises(ValueError):
        clustered_dataset(10, 5, 4, 0, seed=1)
    with pytest.raises(ValueError):
        Dataset(vectors=np.zeros((3, 4)), queries=np.zeros((2, 5)))
    with pytest.raises(ValueError):
        Dataset(vectors=np.zeros(3), queries=np.zeros((2, 3)))
