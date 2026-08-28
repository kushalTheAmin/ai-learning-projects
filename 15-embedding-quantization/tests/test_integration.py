"""End to end on a small seeded dataset: quantize, index, search, recover.

Bounds are calibrated against the committed seeds; everything is
deterministic, so a change that moves recall is a change in behavior.
"""

import numpy as np
import pytest

from main import build_flat, flat_recall, flat_truth, reconstruct
from quantization.rerank import search_with_rerank
from quantization.reuse import HnswIndex, ann_recall, clustered_dataset, mean
from quantization.scalar import (
    fit_grid,
    grid_decode,
    grid_encode,
    symmetric_decode,
    symmetric_encode,
    total_bytes,
)

N, Q, DIM, CLUSTERS, SEED, K = 400, 40, 16, 8, 42, 10


@pytest.fixture(scope="module")
def data():
    return clustered_dataset(N, Q, DIM, CLUSTERS, seed=SEED)


@pytest.fixture(scope="module")
def truth(data):
    return flat_truth(data.vectors, data.queries)


class TestFlatRecall:
    def test_int8_is_near_lossless(self, data, truth):
        recall = flat_recall(reconstruct("int8-asym-dim", data.vectors), data.queries, truth)
        assert recall >= 0.95

    def test_float32_is_lossless_here(self, data, truth):
        recall = flat_recall(reconstruct("float32", data.vectors), data.queries, truth)
        assert recall == 1.0

    def test_int4_loses_visibly_more_than_int8(self, data, truth):
        r8 = flat_recall(reconstruct("int8-asym-dim", data.vectors), data.queries, truth)
        r4 = flat_recall(reconstruct("int4-asym-dim", data.vectors), data.queries, truth)
        assert r4 < r8 - 0.05

    def test_memory_ordering_matches_recall_ordering_story(self):
        fp32 = total_bytes("float32", N, DIM)
        i8 = total_bytes("int8-asym-dim", N, DIM)
        i4 = total_bytes("int4-asym-dim", N, DIM)
        assert i4 < i8 < fp32
        assert fp32 / i8 > 3.5 and fp32 / i4 > 7.0


class TestRerankRecovery:
    def test_small_float_rerank_recovers_int4(self, data, truth):
        recon = reconstruct("int4-asym-dim", data.vectors)
        quant = build_flat(recon)
        quant_only = flat_recall(recon, data.queries, truth)
        reranked = mean(
            [
                ann_recall(
                    search_with_rerank(quant, data.vectors, q, K, n_candidates=40),
                    exact,
                    K,
                )
                for q, exact in zip(data.queries, truth)
            ]
        )
        assert reranked > quant_only + 0.1
        assert reranked >= 0.97


class TestHnswOnQuantizedStore:
    def test_quantized_store_tracks_float_store(self, data, truth):
        recon = reconstruct("int8-asym-dim", data.vectors)
        index = HnswIndex(dim=DIM, m=16, ef_construction=100, seed=SEED)
        for row in recon:
            index.add(row)
        recall = mean(
            [
                ann_recall(index.search(q, K, ef=80), exact, K)
                for q, exact in zip(data.queries, truth)
            ]
        )
        assert recall >= 0.93


class TestFailureModes:
    def test_rogue_dimension_breaks_per_vector_symmetric_only(self, data):
        rng = np.random.default_rng(SEED + 1)
        vectors = np.hstack([data.vectors, 40.0 + rng.normal(0, 0.02, (N, 1))])
        queries = np.hstack([data.queries, 40.0 + rng.normal(0, 0.02, (Q, 1))])
        t = flat_truth(vectors, queries)
        sym = flat_recall(symmetric_decode(symmetric_encode(vectors)), queries, t)
        grid = fit_grid(vectors, 256)
        asym = flat_recall(grid_decode(grid, grid_encode(grid, vectors)), queries, t)
        assert sym < asym - 0.2
        assert asym >= 0.95

    def test_rogue_vectors_break_minmax_grid_and_quantile_fit_recovers(self, data):
        rng = np.random.default_rng(SEED + 2)
        vectors = data.vectors.copy()
        vectors[rng.choice(N, size=3, replace=False)] = rng.uniform(-40, 40, (3, DIM))
        t = flat_truth(vectors, data.queries)
        minmax_grid = fit_grid(vectors, 256)
        minmax = flat_recall(
            grid_decode(minmax_grid, grid_encode(minmax_grid, vectors)), data.queries, t
        )
        clip_grid = fit_grid(vectors, 256, clip_quantile=0.01)
        clipped = flat_recall(
            grid_decode(clip_grid, grid_encode(clip_grid, vectors)), data.queries, t
        )
        assert minmax < clipped - 0.1
        assert clipped >= 0.9


class TestEdges:
    def test_single_vector_collection(self):
        vectors = np.array([[1.0, 2.0, 3.0]])
        recon = reconstruct("int8-sym-vec", vectors)
        results = build_flat(recon).search(np.array([1.0, 2.0, 3.0]), 10)
        assert len(results) == 1 and results[0][0] == 0

    def test_query_dimension_mismatch_raises(self, data):
        index = build_flat(reconstruct("int8-asym-dim", data.vectors))
        with pytest.raises(ValueError):
            index.search(np.zeros(DIM + 1), K)

    def test_unknown_scheme_raises(self, data):
        with pytest.raises(ValueError):
            reconstruct("int2-magic", data.vectors)
