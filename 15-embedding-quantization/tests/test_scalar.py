import numpy as np
import pytest

from quantization.scalar import (
    fit_grid,
    grid_decode,
    grid_encode,
    pack_nibbles,
    rmse,
    symmetric_decode,
    symmetric_encode,
    total_bytes,
    unpack_nibbles,
)


def seeded(n: int, d: int, seed: int = 7) -> np.ndarray:
    return np.random.default_rng(seed).normal(0.0, 1.0, size=(n, d))


# -- symmetric per-vector ---------------------------------------------------


class TestSymmetric:
    def test_codes_are_int8_in_range(self):
        enc = symmetric_encode(seeded(50, 16))
        assert enc.codes.dtype == np.int8
        assert enc.codes.min() >= -127 and enc.codes.max() <= 127

    def test_largest_magnitude_entry_hits_127(self):
        x = np.array([[0.5, -2.0, 1.0]])
        enc = symmetric_encode(x)
        assert enc.scales[0] == pytest.approx(2.0 / 127.0)
        assert enc.codes[0, 1] == -127

    def test_roundtrip_error_bounded_by_half_step(self):
        x = seeded(80, 24)
        enc = symmetric_encode(x)
        err = np.abs(symmetric_decode(enc) - x)
        assert np.all(err <= enc.scales[:, None] / 2.0 + 1e-12)

    def test_scale_is_per_vector_not_global(self):
        x = np.array([[100.0, 50.0], [0.01, 0.005]])
        decoded = symmetric_decode(symmetric_encode(x))
        # the tiny vector keeps its own resolution despite the huge one
        assert np.allclose(decoded[1], x[1], atol=0.01 / 254.0 + 1e-12)

    def test_zero_vector_roundtrips_to_zero(self):
        x = np.array([[0.0, 0.0, 0.0], [1.0, -1.0, 0.5]])
        enc = symmetric_encode(x)
        assert enc.scales[0] == 0.0
        assert np.all(symmetric_decode(enc)[0] == 0.0)

    def test_single_vector_single_dim(self):
        decoded = symmetric_decode(symmetric_encode(np.array([[-3.5]])))
        assert decoded[0, 0] == pytest.approx(-3.5)

    def test_deterministic(self):
        x = seeded(20, 8)
        a, b = symmetric_encode(x), symmetric_encode(x)
        assert np.array_equal(a.codes, b.codes)
        assert np.array_equal(a.scales, b.scales)

    @pytest.mark.parametrize(
        "bad",
        [
            np.array([1.0, 2.0]),  # 1-d
            np.empty((0, 4)),  # no rows
            np.empty((4, 0)),  # no dims
            np.array([[1.0, np.nan]]),
            np.array([[np.inf, 0.0]]),
        ],
    )
    def test_rejects_malformed_input(self, bad):
        with pytest.raises(ValueError):
            symmetric_encode(bad)


# -- per-dimension grid -----------------------------------------------------


class TestGrid:
    def test_codes_are_uint8_in_range(self):
        x = seeded(50, 16)
        grid = fit_grid(x, levels=256)
        codes = grid_encode(grid, x)
        assert codes.dtype == np.uint8
        assert codes.max() <= 255

    def test_minmax_fit_endpoints_are_exact(self):
        x = np.array([[0.0, -5.0], [10.0, 5.0], [4.0, 0.0]])
        grid = fit_grid(x, levels=256)
        decoded = grid_decode(grid, grid_encode(grid, x))
        assert decoded[0, 0] == pytest.approx(0.0)
        assert decoded[1, 0] == pytest.approx(10.0)
        assert decoded[0, 1] == pytest.approx(-5.0)

    def test_roundtrip_error_bounded_by_half_step(self):
        x = seeded(80, 24)
        grid = fit_grid(x, levels=256)
        err = np.abs(grid_decode(grid, grid_encode(grid, x)) - x)
        assert np.all(err <= grid.step[None, :] / 2.0 + 1e-12)

    def test_int4_error_is_wider_than_int8(self):
        x = seeded(100, 16)
        recon8 = grid_decode(fit_grid(x, 256), grid_encode(fit_grid(x, 256), x))
        recon4 = grid_decode(fit_grid(x, 16), grid_encode(fit_grid(x, 16), x))
        assert rmse(x, recon4) > rmse(x, recon8)

    def test_constant_dimension_reconstructs_exactly(self):
        x = np.array([[3.0, 1.0], [3.0, 2.0], [3.0, 5.0]])
        grid = fit_grid(x, levels=256)
        assert grid.step[0] == 0.0
        decoded = grid_decode(grid, grid_encode(grid, x))
        assert np.all(decoded[:, 0] == 3.0)

    def test_out_of_grid_values_clip_to_edges(self):
        train = np.array([[0.0], [1.0]])
        grid = fit_grid(train, levels=256)
        decoded = grid_decode(grid, grid_encode(grid, np.array([[-99.0], [99.0]])))
        assert decoded[0, 0] == pytest.approx(0.0)
        assert decoded[1, 0] == pytest.approx(1.0)

    def test_quantile_fit_ignores_outlier_rows(self):
        rng = np.random.default_rng(3)
        x = rng.uniform(0.0, 1.0, size=(1000, 4))
        x[0] = 1000.0
        clipped = fit_grid(x, levels=256, clip_quantile=0.01)
        stretched = fit_grid(x, levels=256)
        assert np.all(clipped.step < stretched.step / 100.0)

    def test_quantile_zero_equals_minmax(self):
        x = seeded(50, 8)
        a, b = fit_grid(x, 256, clip_quantile=0.0), fit_grid(x, 256)
        assert np.array_equal(a.lo, b.lo) and np.array_equal(a.step, b.step)

    def test_encode_dim_mismatch_raises(self):
        grid = fit_grid(seeded(10, 4), 256)
        with pytest.raises(ValueError):
            grid_encode(grid, seeded(10, 5))
        with pytest.raises(ValueError):
            grid_decode(grid, np.zeros((10, 5), dtype=np.uint8))

    @pytest.mark.parametrize("levels", [1, 0, -3])
    def test_bad_levels_raise(self, levels):
        with pytest.raises(ValueError):
            fit_grid(seeded(10, 4), levels=levels)

    @pytest.mark.parametrize("q", [0.5, 0.7, -0.01])
    def test_bad_quantile_raises(self, q):
        with pytest.raises(ValueError):
            fit_grid(seeded(10, 4), levels=256, clip_quantile=q)

    def test_fit_rejects_nan(self):
        with pytest.raises(ValueError):
            fit_grid(np.array([[1.0, np.nan]]), 256)


# -- nibble packing ---------------------------------------------------------


class TestNibbles:
    @pytest.mark.parametrize("d", [1, 2, 7, 8, 33])
    def test_roundtrip(self, d):
        rng = np.random.default_rng(d)
        codes = rng.integers(0, 16, size=(9, d)).astype(np.uint8)
        packed = pack_nibbles(codes)
        assert packed.shape == (9, (d + 1) // 2)
        assert np.array_equal(unpack_nibbles(packed, d), codes)

    def test_rejects_codes_above_15(self):
        with pytest.raises(ValueError):
            pack_nibbles(np.array([[16]], dtype=np.uint8))

    def test_unpack_shape_mismatch_raises(self):
        with pytest.raises(ValueError):
            unpack_nibbles(np.zeros((3, 4), dtype=np.uint8), dim=33)


# -- accounting -------------------------------------------------------------


class TestAccounting:
    def test_exact_byte_math(self):
        n, d = 1000, 32
        assert total_bytes("float64", n, d) == 256000
        assert total_bytes("float32", n, d) == 128000
        assert total_bytes("int8-sym-vec", n, d) == 32000 + 4000
        assert total_bytes("int8-asym-dim", n, d) == 32000 + 256
        assert total_bytes("int4-asym-dim", n, d) == 16000 + 256

    def test_int4_odd_dim_rounds_up(self):
        assert total_bytes("int4-asym-dim", 10, 5) == 10 * 3 + 40

    def test_unknown_scheme_raises(self):
        with pytest.raises(ValueError):
            total_bytes("int2", 10, 10)

    def test_nonpositive_sizes_raise(self):
        with pytest.raises(ValueError):
            total_bytes("float32", 0, 10)

    def test_rmse_known_value(self):
        a = np.array([[0.0, 0.0], [0.0, 0.0]])
        b = np.array([[1.0, 1.0], [1.0, 1.0]])
        assert rmse(a, b) == pytest.approx(1.0)

    def test_rmse_shape_mismatch_raises(self):
        with pytest.raises(ValueError):
            rmse(np.zeros((2, 2)), np.zeros((2, 3)))
