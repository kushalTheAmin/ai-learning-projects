"""End to end on a small seeded dataset: quantize, index, search, recover.

Bounds are calibrated against the committed seeds; everything is
deterministic, so a change that moves recall is a change in behavior.
"""

import re
from pathlib import Path

import numpy as np
import pytest

from main import (
    CLIP_QUANTILES,
    SEED,
    build_flat,
    clip_quantile_sweep,
    flat_recall,
    flat_truth,
    inject_rogue_vectors,
    reconstruct,
    rogue_vectors,
    scheme_table,
)
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

N, Q, DIM, CLUSTERS, K = 400, 40, 16, 8, 10
PROJECT = Path(__file__).resolve().parents[1]


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


class TestSchemeTableMemoryColumns:
    """The memory columns are the project's headline axis, so every cell in
    them has to come out of `total_bytes`, the truth row included."""

    LABELS = {"float64 truth": "float64"}

    @staticmethod
    def _rows(text: str) -> list[tuple[str, int, float, float]]:
        """(scheme, bytes, B/vec, vs fp32) per data row of a printed table."""
        rows = []
        for line in text.splitlines():
            parts = line.split()
            if len(parts) < 6 or not parts[-1].endswith("x"):
                continue
            label = " ".join(parts[:-5])
            if label == "scheme":
                continue
            rows.append(
                (label, int(parts[-3]), float(parts[-2]), float(parts[-1][:-1]))
            )
        return rows

    def test_every_row_prices_itself_with_total_bytes(self, data, capsys):
        scheme_table("clustered", data)
        rows = self._rows(capsys.readouterr().out)
        assert len(rows) == 5, f"expected 5 scheme rows, got {len(rows)}"
        for label, size, per_vec, _ in rows:
            scheme = self.LABELS.get(label, label)
            assert size == total_bytes(scheme, N, DIM), f"{label} bytes"
            assert per_vec == pytest.approx(size / N, abs=0.05), f"{label} B/vec"

    def test_vs_fp32_is_the_compression_multiple_in_every_row(self, data, capsys):
        scheme_table("clustered", data)
        rows = self._rows(capsys.readouterr().out)
        fp32 = total_bytes("float32", N, DIM)
        for label, size, _, printed in rows:
            assert printed == pytest.approx(round(fp32 / size, 2), abs=1e-9), (
                f"{label} prints {printed}x in the vs fp32 column but is "
                f"{fp32 / size:.2f}x the size of fp32's {fp32} bytes"
            )

    def test_a_store_larger_than_fp32_reads_as_larger(self, data, capsys):
        """float64 is the one row above fp32, so it is the row that catches a
        cell written with the ratio the wrong way up."""
        scheme_table("clustered", data)
        rows = {label: printed for label, _, _, printed in self._rows(capsys.readouterr().out)}
        assert rows["float64 truth"] < 1.0 < rows["int8-asym-dim"], (
            "float64 holds twice fp32's bytes, so its vs fp32 cell must sit "
            f"below 1.00x like a bigger store, not at {rows['float64 truth']}x"
        )


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



CLIP_PUBLISHED = dict(n=3000, n_queries=150, dim=32, clusters=24, n_rogue=5)


def _swept(vectors, queries):
    return clip_quantile_sweep(
        vectors, queries, flat_truth(vectors, queries), CLIP_QUANTILES
    )


def _bulk_step(vectors, rogue_ids):
    """The step the uncorrupted rows need on their own: the honest thing the
    min/max stretch is a multiple of."""
    bulk = np.delete(vectors, rogue_ids, axis=0)
    return float(np.mean(fit_grid(bulk, levels=256).step))


@pytest.fixture(scope="module")
def contaminated(data):
    vectors, rogue_ids = inject_rogue_vectors(data, 3, 40.0)
    return vectors, rogue_ids


# | 0.002 | 6.0 | 0.0062 | 0.983 |
_CLIP_ROW = re.compile(
    r"^\|\s*(0\.\d{3})\s*\|\s*([\d.]+)\s*\|\s*(\d\.\d{4})\s*\|"
    r"\s*(\d\.\d{3})\s*\|",
    re.MULTILINE,
)
# "29x coarser than the 0.0070 the 2995 clean rows need"
_CLIP_STRETCH = re.compile(
    r"mean step lands at ([\d.]+), (\d+)x coarser than the (\d\.\d{4}) "
    r"the (\d+) clean rows need"
)


@pytest.fixture(scope="module")
def readme():
    return (PROJECT / "README.md").read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def rows(readme):
    found = _CLIP_ROW.findall(readme)
    assert len(found) >= 4, (
        f"the readme publishes {len(found)} clip-fraction rows; the "
        "rogue-vector recovery is a tuned operating point, so it needs its "
        "sweep shown and not just its peak"
    )
    return found


@pytest.fixture(scope="module")
def published_sweep():
    p = CLIP_PUBLISHED
    base = clustered_dataset(p["n"], p["n_queries"], p["dim"], p["clusters"], seed=SEED)
    vectors, rogue_ids = inject_rogue_vectors(base, p["n_rogue"], 40.0)
    return _swept(vectors, base.queries), _bulk_step(vectors, rogue_ids)


class TestQuantileClipIsAnOperatingPoint:
    """The quantile fit's recovery is the peak of a sweep, so the sweep is
    what has to be published.

    One clip fraction reads as a property of the method. It is not: the
    fraction only works once it clips more rows per tail than the corruption
    has rows, and nothing in a deployment measures that rate. Publishing the
    peak alone hides the cliff below it (rogues stay in the fit) and the
    drift above it (real data clips), which is what a reader needs in order
    to discount the number.
    """

    def test_clipping_only_ever_narrows_the_grid(self, data, contaminated):
        vectors, _ = contaminated
        rows = _swept(vectors, data.queries)
        assert [q for q, _, _ in rows] == CLIP_QUANTILES
        steps = [step for _, step, _ in rows]
        assert steps == sorted(steps, reverse=True), (
            f"a wider clip fraction cannot widen the grid, got steps {steps}"
        )
        assert all(0.0 <= recall <= 1.0 for _, _, recall in rows)

    def test_the_best_fraction_sits_inside_the_sweep(self, data, contaminated):
        """Both ends of the knob are wrong, so no single row is the method's
        number: too small leaves the rogue stretch in, too large clips the
        bulk."""
        vectors, _ = contaminated
        recalls = [recall for _, _, recall in _swept(vectors, data.queries)]
        best = max(range(len(recalls)), key=lambda i: recalls[i])
        assert 0 < best < len(recalls) - 1, (
            f"swept fractions {CLIP_QUANTILES} peak at the edge (index {best}), "
            f"recalls {[round(r, 3) for r in recalls]} — the sweep has to "
            "straddle the peak for the published row to be readable as one"
        )
        assert recalls[best] > recalls[0] and recalls[best] > recalls[-1]

    def test_the_minmax_stretch_is_measured_against_the_clean_rows(
        self, data, contaminated
    ):
        """The rogue rows' damage is how far the fitted grid sits above the
        step the clean rows need. A clipped grid's step is below that by
        construction, so quoting one as the bulk's requirement understates
        the stretch."""
        vectors, rogue_ids = contaminated
        rows = _swept(vectors, data.queries)
        bulk = _bulk_step(vectors, rogue_ids)
        minmax = next(step for q, step, _ in rows if q == 0.0)
        assert minmax > 10 * bulk, (
            f"min/max step {minmax:.4f} vs the clean rows' {bulk:.4f}: the "
            "injection is supposed to stretch the grid by orders of magnitude"
        )
        clipped = [step for q, step, _ in rows if q > 0.0]
        assert all(step < minmax for step in clipped)

    def test_printed_block_publishes_every_swept_fraction(self, data, capsys):
        rogue_vectors(data, n_rogue=3, magnitude=40.0)
        out = capsys.readouterr().out
        for q in CLIP_QUANTILES:
            assert f"{q:.4f}" in out, f"clip fraction {q} is swept but not printed"
        assert "clean rows need mean step" in out, (
            "the printed block names no uncorrupted-bulk reference step, so the "
            "min/max stretch has nothing honest to be a multiple of"
        )
        assert "<- best" in out, "the printed sweep does not mark its peak"


class TestReadmePublishesTheClipSweep:
    """The published configuration's sweep, bound to the README.

    Nothing else here would notice the rogue-vector paragraph drifting: its
    numbers come from `main.py` at the published sizes, not from the small
    fixture the rest of these tests run on.
    """

    def test_every_published_row_matches_the_sweep(self, rows, published_sweep):
        sweep, _ = published_sweep
        swept = {round(q, 4): (step, recall) for q, step, recall in sweep}
        for frac, per_tail, step, recall in rows:
            q = round(float(frac), 4)
            assert q in swept, f"readme publishes clip {frac}; main.py does not sweep it"
            assert float(step) == pytest.approx(swept[q][0], abs=5e-5), f"clip {frac} step"
            assert float(recall) == pytest.approx(swept[q][1], abs=5e-4), f"clip {frac} recall"
            assert float(per_tail) == pytest.approx(
                q * CLIP_PUBLISHED["n"], abs=0.05
            ), f"clip {frac} rows per tail"

    def test_the_readme_straddles_the_peak_it_publishes(self, rows, published_sweep):
        """The best row needs a published row on each side of it, or the
        number still reads as what a quantile fit just buys."""
        sweep, _ = published_sweep
        fracs = [round(float(f), 4) for f, _, _, _ in rows]
        recalls = [float(r) for _, _, _, r in rows]
        best = max(range(len(recalls)), key=lambda i: recalls[i])
        assert 0 < best < len(recalls) - 1, (
            f"the readme's best clip row ({fracs[best]}, recall {recalls[best]:.3f}) "
            "is an endpoint of what it publishes, so the cliff on one side is "
            "invisible to a reader"
        )
        peak = max(sweep, key=lambda row: row[2])
        assert fracs[best] == round(peak[0], 4), (
            f"the readme's best published row is clip {fracs[best]} but the sweep "
            f"peaks at {peak[0]}"
        )

    def test_the_stretch_is_quoted_against_the_clean_rows_step(
        self, readme, published_sweep
    ):
        """The sentence that prices the damage has to divide by the step the
        uncorrupted rows need, not by the clipped grid's step."""
        sweep, bulk_step = published_sweep
        claim = _CLIP_STRETCH.search(readme)
        assert claim is not None, (
            "the readme no longer prices the min/max stretch against the clean rows"
        )
        quoted_minmax = float(claim.group(1))
        quoted_multiple = int(claim.group(2))
        quoted_bulk = float(claim.group(3))
        quoted_clean_rows = int(claim.group(4))

        minmax = next(step for q, step, _ in sweep if q == 0.0)
        assert quoted_minmax == pytest.approx(minmax, abs=5e-5)
        assert quoted_bulk == pytest.approx(bulk_step, abs=5e-5), (
            f"the readme says the clean rows need {quoted_bulk}, they need "
            f"{bulk_step:.4f}"
        )
        assert quoted_clean_rows == CLIP_PUBLISHED["n"] - CLIP_PUBLISHED["n_rogue"]
        assert quoted_multiple == round(minmax / bulk_step), (
            f"{minmax:.4f} / {bulk_step:.4f} is "
            f"{minmax / bulk_step:.1f}x, the readme says {quoted_multiple}x"
        )

    def test_the_peak_already_clips_part_of_the_bulk(self, published_sweep):
        """At the published sizes the winning fraction's step is below what the
        clean rows need, which is the cost the paragraph has to own."""
        sweep, bulk_step = published_sweep
        peak = max(sweep, key=lambda row: row[2])
        assert peak[1] < bulk_step
