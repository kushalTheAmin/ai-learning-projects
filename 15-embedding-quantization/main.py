"""Float32 vs int8 vs int4 vector storage: recall against memory.

Everything is deterministic: seeded synthetic vectors, exact float64
ground truth, quantized search as float search over the dequantized
reconstruction. Memory columns price what each scheme keeps in RAM.
"""

import numpy as np

from quantization.rerank import search_with_rerank
from quantization.reuse import (
    Dataset,
    ExactIndex,
    HnswIndex,
    ann_recall,
    clustered_dataset,
    mean,
    uniform_dataset,
)
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

SEED = 42
K = 10

SCHEMES = ["float32", "int8-sym-vec", "int8-asym-dim", "int4-asym-dim"]


def reconstruct(scheme: str, vectors: np.ndarray) -> np.ndarray:
    """The float vectors a search over this scheme's codes is equivalent to."""
    if scheme == "float32":
        return vectors.astype(np.float32).astype(np.float64)
    if scheme == "int8-sym-vec":
        return symmetric_decode(symmetric_encode(vectors))
    if scheme == "int8-asym-dim":
        grid = fit_grid(vectors, levels=256)
        return grid_decode(grid, grid_encode(grid, vectors))
    if scheme == "int4-asym-dim":
        grid = fit_grid(vectors, levels=16)
        codes = grid_encode(grid, vectors)
        # store as packed nibbles, exactly as the byte accounting assumes
        codes = unpack_nibbles(pack_nibbles(codes), vectors.shape[1])
        return grid_decode(grid, codes)
    raise ValueError(f"unknown scheme {scheme!r}")


def build_flat(vectors: np.ndarray) -> ExactIndex:
    index = ExactIndex(dim=vectors.shape[1])
    for row in vectors:
        index.add(row)
    return index


def flat_truth(vectors: np.ndarray, queries: np.ndarray) -> list[list[tuple[int, float]]]:
    index = build_flat(vectors)
    return [index.search(q, K) for q in queries]


def flat_recall(
    vectors: np.ndarray,
    queries: np.ndarray,
    truth: list[list[tuple[int, float]]],
) -> float:
    index = build_flat(vectors)
    results = [index.search(q, K) for q in queries]
    return mean([ann_recall(res, exact, K) for res, exact in zip(results, truth)])


def scheme_table(name: str, data: Dataset) -> None:
    n, dim = data.vectors.shape
    truth = flat_truth(data.vectors, data.queries)
    fp32 = total_bytes("float32", n, dim)
    print(f"-- {name}: {n} vectors, dim {dim}, {len(data.queries)} queries --")
    print(f"{'scheme':<14} {'recall@10':>9} {'rmse':>8} {'bytes':>8} {'B/vec':>6} {'vs fp32':>8}")
    print(f"{'float64 truth':<14} {'1.000':>9} {'0.0000':>8} {total_bytes('float64', n, dim):>8} {total_bytes('float64', n, dim) / n:>6.1f} {'2.00x':>8}")
    for scheme in SCHEMES:
        recon = reconstruct(scheme, data.vectors)
        recall = flat_recall(recon, data.queries, truth)
        err = rmse(data.vectors, recon)
        size = total_bytes(scheme, n, dim)
        print(
            f"{scheme:<14} {recall:>9.3f} {err:>8.4f} {size:>8} "
            f"{size / n:>6.1f} {fp32 / size:>7.2f}x"
        )
    print()


def build_hnsw(vectors: np.ndarray) -> HnswIndex:
    index = HnswIndex(dim=vectors.shape[1], m=16, ef_construction=100, seed=SEED)
    for row in vectors:
        index.add(row)
    return index


def hnsw_sweep(data: Dataset) -> None:
    truth = flat_truth(data.vectors, data.queries)
    float_index = build_hnsw(data.vectors)
    recon = reconstruct("int8-asym-dim", data.vectors)
    quant_index = build_hnsw(recon)
    quant_flat = flat_recall(recon, data.queries, truth)

    print("-- hnsw (M=16, efConstruction=100) on float64 vs int8-asym-dim store --")
    print("recall@10 vs exact float64 truth; int8 flat scan is the ef->inf ceiling")
    print(f"{'ef':>4} {'hnsw fp64':>10} {'hnsw int8':>10} {'quantization gap':>17}")
    for ef in [10, 20, 40, 80, 160]:
        r_float = mean(
            [
                ann_recall(float_index.search(q, K, ef=ef), exact, K)
                for q, exact in zip(data.queries, truth)
            ]
        )
        r_quant = mean(
            [
                ann_recall(quant_index.search(q, K, ef=ef), exact, K)
                for q, exact in zip(data.queries, truth)
            ]
        )
        gap = r_float - r_quant
        print(f"{ef:>4} {r_float:>10.3f} {r_quant:>10.3f} {gap:>+17.3f}")
    print(f"int8-asym-dim flat scan ceiling: {quant_flat:.3f}\n")


def rerank_sweep(data: Dataset) -> None:
    n = data.vectors.shape[0]
    truth = flat_truth(data.vectors, data.queries)
    print("-- rerank: quantized flat top-C, float64 rows refetched for the top C --")
    print(f"{'scheme':<14} {'C=10':>7} {'C=20':>7} {'C=50':>7} {'C=100':>7} {'C=200':>7}")
    for scheme in ["int8-asym-dim", "int4-asym-dim"]:
        index = build_flat(reconstruct(scheme, data.vectors))
        row = []
        for c in [10, 20, 50, 100, 200]:
            results = [
                search_with_rerank(index, data.vectors, q, K, n_candidates=min(c, n))
                for q in data.queries
            ]
            row.append(mean([ann_recall(res, exact, K) for res, exact in zip(results, truth)]))
        print(f"{scheme:<14} " + " ".join(f"{r:>7.3f}" for r in row))
    print()


def rogue_dimension(base: Dataset, magnitude: float) -> None:
    """Append a near-constant large dimension, the shape transformer
    embeddings are known for: it barely moves true distances (a constant
    cancels in differences) but it owns every per-vector scale."""
    rng = np.random.default_rng(SEED + 1)
    rogue_col = magnitude + rng.normal(0.0, 0.02, size=(base.vectors.shape[0], 1))
    rogue_q = magnitude + rng.normal(0.0, 0.02, size=(base.queries.shape[0], 1))
    vectors = np.hstack([base.vectors, rogue_col])
    queries = np.hstack([base.queries, rogue_q])
    truth = flat_truth(vectors, queries)

    sym_step = float(np.mean(np.max(np.abs(vectors), axis=1) / 127.0))
    informative_span = float(np.mean(np.ptp(vectors[:, :-1], axis=0)))
    print(f"-- failure: one rogue dimension at ~{magnitude} appended (dim {vectors.shape[1]}) --")
    print(
        f"per-vector symmetric step becomes {sym_step:.3f}, so an informative "
        f"dimension spanning {informative_span:.2f} keeps ~{informative_span / sym_step:.0f} "
        f"of its 255 levels"
    )
    for scheme in ["int8-sym-vec", "int8-asym-dim"]:
        recall = flat_recall(reconstruct(scheme, vectors), queries, truth)
        print(f"{scheme:<14} recall@10 {recall:.3f}")
    clean = flat_recall(
        reconstruct("int8-sym-vec", base.vectors),
        base.queries,
        flat_truth(base.vectors, base.queries),
    )
    print(f"(int8-sym-vec on the same data without the rogue dimension: {clean:.3f})\n")


def rogue_vectors(base: Dataset, n_rogue: int, magnitude: float) -> None:
    """Corrupt a few rows to huge values: min/max grids stretch to cover
    them and everyone else loses resolution. A quantile fit clips them."""
    rng = np.random.default_rng(SEED + 2)
    vectors = base.vectors.copy()
    rogue_ids = rng.choice(vectors.shape[0], size=n_rogue, replace=False)
    vectors[rogue_ids] = rng.uniform(-magnitude, magnitude, size=(n_rogue, vectors.shape[1]))
    truth = flat_truth(vectors, base.queries)

    grid_minmax = fit_grid(vectors, levels=256)
    grid_clip = fit_grid(vectors, levels=256, clip_quantile=0.002)
    print(f"-- failure: {n_rogue} rogue vectors in U(-{magnitude:.0f}, {magnitude:.0f}) --")
    print(
        f"mean per-dim step: minmax fit {float(np.mean(grid_minmax.step)):.4f}, "
        f"quantile(0.002) fit {float(np.mean(grid_clip.step)):.4f}"
    )
    rows = [
        ("int8-asym-dim minmax", grid_decode(grid_minmax, grid_encode(grid_minmax, vectors))),
        ("int8-asym-dim q0.002", grid_decode(grid_clip, grid_encode(grid_clip, vectors))),
        ("int8-sym-vec", symmetric_decode(symmetric_encode(vectors))),
    ]
    for label, recon in rows:
        recall = flat_recall(recon, base.queries, truth)
        print(f"{label:<22} recall@10 {recall:.3f}")
    print()


def main() -> None:
    n, n_queries, dim, clusters = 3000, 150, 32, 24
    clustered = clustered_dataset(n, n_queries, dim, clusters, seed=SEED)
    uniform = uniform_dataset(n, n_queries, dim, seed=SEED)
    print("== flat exact search over quantized stores ==")
    scheme_table("clustered", clustered)
    scheme_table("uniform", uniform)

    print("== quantization under hnsw ==")
    hnsw_sweep(clustered)

    print("== float rerank recovery ==")
    rerank_sweep(clustered)

    print("== failure modes ==")
    rogue_dimension(clustered, magnitude=40.0)
    rogue_vectors(clustered, n_rogue=5, magnitude=40.0)


if __name__ == "__main__":
    main()
