import numpy as np
import pytest

from quantization.rerank import float_rerank, search_with_rerank
from quantization.reuse import ExactIndex
from quantization.scalar import fit_grid, grid_decode, grid_encode


def build_flat(vectors: np.ndarray) -> ExactIndex:
    index = ExactIndex(dim=vectors.shape[1])
    for row in vectors:
        index.add(row)
    return index


@pytest.fixture()
def vectors() -> np.ndarray:
    return np.random.default_rng(11).normal(0.0, 1.0, size=(60, 8))


class TestFloatRerank:
    def test_all_ids_equals_exact_search(self, vectors):
        query = vectors[0] + 0.01
        expected = build_flat(vectors).search(query, 5)
        got = float_rerank(vectors, list(range(len(vectors))), query, 5)
        assert got == expected

    def test_nearest_first_with_id_tiebreak(self):
        vectors = np.array([[1.0], [0.0], [1.0]])
        got = float_rerank(vectors, [2, 0, 1], np.array([1.0]), 3)
        assert got == [(0, 0.0), (2, 0.0), (1, 1.0)]

    def test_fewer_candidates_than_k(self, vectors):
        got = float_rerank(vectors, [3, 7], vectors[3], 10)
        assert len(got) == 2 and got[0][0] == 3

    def test_duplicate_candidates_collapse(self, vectors):
        got = float_rerank(vectors, [5, 5, 5], vectors[5], 3)
        assert got == [(5, 0.0)]

    def test_empty_candidates(self, vectors):
        assert float_rerank(vectors, [], vectors[0], 3) == []

    def test_k_below_one_raises(self, vectors):
        with pytest.raises(ValueError):
            float_rerank(vectors, [0], vectors[0], 0)


class TestSearchWithRerank:
    def test_full_candidate_set_recovers_exact(self, vectors):
        grid = fit_grid(vectors, levels=16)
        recon = grid_decode(grid, grid_encode(grid, vectors))
        quant = build_flat(recon)
        query = vectors[10] + 0.05
        exact = build_flat(vectors).search(query, 5)
        got = search_with_rerank(quant, vectors, query, 5, n_candidates=len(vectors))
        assert got == exact

    def test_rerank_beats_quantized_only_on_coarse_codes(self, vectors):
        grid = fit_grid(vectors, levels=4)
        recon = grid_decode(grid, grid_encode(grid, vectors))
        quant = build_flat(recon)
        exact_index = build_flat(vectors)
        k, c = 5, 25
        rng = np.random.default_rng(12)
        queries = vectors[:20] + rng.normal(0.0, 0.05, size=(20, vectors.shape[1]))

        def hits(results, truth):
            truth_ids = {i for i, _ in truth}
            return sum(1 for i, _ in results if i in truth_ids)

        quant_hits = rerank_hits = 0
        for q in queries:
            truth = exact_index.search(q, k)
            quant_hits += hits(quant.search(q, k), truth)
            rerank_hits += hits(search_with_rerank(quant, vectors, q, k, c), truth)
        assert rerank_hits > quant_hits

    def test_candidates_below_k_raises(self, vectors):
        quant = build_flat(vectors)
        with pytest.raises(ValueError):
            search_with_rerank(quant, vectors, vectors[0], 5, n_candidates=4)
