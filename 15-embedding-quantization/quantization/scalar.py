"""Scalar quantization of embedding vectors.

Two families, whose failure modes are duals of each other:

- symmetric per-vector: one scale per vector, max|x| / 127, codes in
  [-127, 127]. No fit pass over the collection, so a rogue vector hurts
  only itself — but one large dimension inside a vector sets the scale for
  every other dimension of that vector.
- asymmetric per-dimension: a [lo, hi] grid per dimension fitted over the
  whole collection, codes in [0, levels - 1]. A large-but-constant
  dimension gets its own tight grid — but one rogue vector stretches every
  dimension's grid for everyone. An optional quantile fit clips the grid to
  the bulk of the data, trading exactness on outliers for resolution on
  the rest.

Distances are computed on the dequantized reconstruction (asymmetric
distance: queries stay float), so quantization plugs into any float index
unchanged. Codes are what a deployment would hold in RAM; memory accounting
below prices exactly that.
"""

from dataclasses import dataclass

import numpy as np


def _check_matrix(x: np.ndarray, name: str = "matrix") -> np.ndarray:
    x = np.asarray(x, dtype=np.float64)
    if x.ndim != 2:
        raise ValueError(f"{name} must be 2-d, got ndim {x.ndim}")
    if x.shape[0] < 1 or x.shape[1] < 1:
        raise ValueError(f"{name} must be non-empty, got shape {x.shape}")
    if not np.all(np.isfinite(x)):
        raise ValueError(f"{name} contains nan or inf")
    return x


# -- symmetric per-vector int8 ---------------------------------------------


@dataclass(frozen=True)
class SymmetricCodes:
    """Int8 codes with one reconstruction scale per vector."""

    codes: np.ndarray  # int8, shape (n, d)
    scales: np.ndarray  # float64, shape (n,); 0.0 only for an all-zero vector


def symmetric_encode(x: np.ndarray) -> SymmetricCodes:
    x = _check_matrix(x, "vectors")
    scales = np.max(np.abs(x), axis=1) / 127.0
    safe = np.where(scales == 0.0, 1.0, scales)
    codes = np.clip(np.rint(x / safe[:, None]), -127, 127).astype(np.int8)
    return SymmetricCodes(codes=codes, scales=scales)


def symmetric_decode(encoded: SymmetricCodes) -> np.ndarray:
    return encoded.codes.astype(np.float64) * encoded.scales[:, None]


# -- asymmetric per-dimension grid (int8 at 256 levels, int4 at 16) --------


@dataclass(frozen=True)
class DimGrid:
    """Per-dimension uniform grid: value = lo + code * step."""

    lo: np.ndarray  # float64, shape (d,)
    step: np.ndarray  # float64, shape (d,); 0.0 for a constant dimension
    levels: int

    @property
    def dim(self) -> int:
        return int(self.lo.shape[0])


def fit_grid(x: np.ndarray, levels: int = 256, clip_quantile: float = 0.0) -> DimGrid:
    """Fit per-dimension [lo, hi] over the collection.

    clip_quantile q > 0 fits the grid to the [q, 1-q] quantiles per
    dimension instead of min/max; values outside clip to the grid edge at
    encode time.
    """
    x = _check_matrix(x, "vectors")
    if levels < 2:
        raise ValueError(f"levels must be >= 2, got {levels}")
    if not 0.0 <= clip_quantile < 0.5:
        raise ValueError(f"clip_quantile must be in [0, 0.5), got {clip_quantile}")
    if clip_quantile > 0.0:
        lo = np.quantile(x, clip_quantile, axis=0)
        hi = np.quantile(x, 1.0 - clip_quantile, axis=0)
    else:
        lo = np.min(x, axis=0)
        hi = np.max(x, axis=0)
    return DimGrid(lo=lo, step=(hi - lo) / (levels - 1), levels=levels)


def grid_encode(grid: DimGrid, x: np.ndarray) -> np.ndarray:
    """Codes as uint8, shape like x. Out-of-grid values clip to the edges."""
    x = _check_matrix(x, "vectors")
    if x.shape[1] != grid.dim:
        raise ValueError(f"expected dim {grid.dim}, got {x.shape[1]}")
    safe = np.where(grid.step == 0.0, 1.0, grid.step)
    codes = np.clip(np.rint((x - grid.lo) / safe), 0, grid.levels - 1)
    return np.where(grid.step == 0.0, 0, codes).astype(np.uint8)


def grid_decode(grid: DimGrid, codes: np.ndarray) -> np.ndarray:
    codes = np.asarray(codes)
    if codes.ndim != 2 or codes.shape[1] != grid.dim:
        raise ValueError(f"codes must have shape (n, {grid.dim}), got {codes.shape}")
    return grid.lo + codes.astype(np.float64) * grid.step


# -- int4 nibble packing ----------------------------------------------------


def pack_nibbles(codes: np.ndarray) -> np.ndarray:
    """Pack codes < 16 two per byte, low nibble first; odd tail pads with 0."""
    codes = np.asarray(codes)
    if codes.ndim != 2:
        raise ValueError(f"codes must be 2-d, got ndim {codes.ndim}")
    if np.any(codes > 15) or np.any(codes < 0):
        raise ValueError("nibble codes must be in [0, 15]")
    n, d = codes.shape
    padded = np.zeros((n, d + d % 2), dtype=np.uint8)
    padded[:, :d] = codes
    return (padded[:, 0::2] | (padded[:, 1::2] << 4)).astype(np.uint8)


def unpack_nibbles(packed: np.ndarray, dim: int) -> np.ndarray:
    packed = np.asarray(packed, dtype=np.uint8)
    if packed.ndim != 2 or packed.shape[1] != (dim + 1) // 2:
        raise ValueError(
            f"packed must have shape (n, {(dim + 1) // 2}) for dim {dim}, "
            f"got {packed.shape}"
        )
    out = np.empty((packed.shape[0], 2 * packed.shape[1]), dtype=np.uint8)
    out[:, 0::2] = packed & 0x0F
    out[:, 1::2] = packed >> 4
    return out[:, :dim]


# -- accounting -------------------------------------------------------------

# What each scheme keeps in memory for n vectors of dimension d. Grid
# parameters are float32 pairs per dimension, per-vector scales float32 each;
# the float rows a reranker fetches are priced separately by the caller.
SCHEME_BYTES = {
    "float64": lambda n, d: 8 * n * d,
    "float32": lambda n, d: 4 * n * d,
    "int8-sym-vec": lambda n, d: n * d + 4 * n,
    "int8-asym-dim": lambda n, d: n * d + 8 * d,
    "int4-asym-dim": lambda n, d: n * ((d + 1) // 2) + 8 * d,
}


def total_bytes(scheme: str, n: int, d: int) -> int:
    if scheme not in SCHEME_BYTES:
        raise ValueError(f"unknown scheme {scheme!r}")
    if n < 1 or d < 1:
        raise ValueError(f"n and d must be >= 1, got n={n}, d={d}")
    return int(SCHEME_BYTES[scheme](n, d))


def rmse(original: np.ndarray, reconstructed: np.ndarray) -> float:
    original = _check_matrix(original, "original")
    reconstructed = _check_matrix(reconstructed, "reconstructed")
    if original.shape != reconstructed.shape:
        raise ValueError(
            f"shape mismatch: {original.shape} vs {reconstructed.shape}"
        )
    return float(np.sqrt(np.mean((original - reconstructed) ** 2)))
