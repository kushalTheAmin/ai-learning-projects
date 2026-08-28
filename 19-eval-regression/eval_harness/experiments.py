"""Measure the gates against scenarios with known ground truth.

Because the model versions are authored, every comparison here has a
true answer: baseline vs baseline is noise and a gate that fails it is
false-alarming, baseline vs a regressed version is real and a gate that
passes it missed. Repeating each comparison over many seed pairs turns
the gate verdicts into rates, and generating larger synthetic golden
sets turns the ci gate's detection rate into a power curve over eval
set size.
"""

from dataclasses import dataclass

from .compare import compare_runs, gate_ci, gate_combined, gate_naive, gate_slice
from .data import GoldenItem
from .datagen import build_golden_items
from .harness import run_eval
from .model import ScriptedModel, stable_u64

NAIVE_THRESHOLDS = (0.01, 0.02)

GATE_NAMES = ("naive-0.01", "naive-0.02", "ci", "slice", "ci+slice")


@dataclass(frozen=True)
class GateRates:
    n_pairs: int
    mean_delta: float
    min_delta: float
    max_delta: float
    fail_rates: dict[str, float]  # gate name -> fraction of pairs failed
    improve_rate: float  # fraction of pairs whose aggregate ci sits above zero


@dataclass(frozen=True)
class PowerPoint:
    n_items: int
    detection_rate: float  # fraction of pairs where the ci gate fails


def _pair_seeds(n_pairs: int, label: str) -> list[tuple[int, int]]:
    """Distinct deterministic (baseline seed, candidate seed) per pair."""
    base = stable_u64("pairs", label) % 1_000_000
    return [(base + 2 * i, base + 2 * i + 1) for i in range(n_pairs)]


def measure_gate_rates(
    items: list[GoldenItem],
    baseline_model: ScriptedModel,
    candidate_model: ScriptedModel,
    n_pairs: int,
    n_resamples: int,
    label: str,
) -> GateRates:
    if n_pairs < 1:
        raise ValueError(f"n_pairs must be >= 1, got {n_pairs}")
    fails = {name: 0 for name in GATE_NAMES}
    deltas: list[float] = []
    improvements = 0
    for pair_index, (base_seed, cand_seed) in enumerate(
        _pair_seeds(n_pairs, label)
    ):
        baseline = run_eval(baseline_model, items, base_seed)
        candidate = run_eval(candidate_model, items, cand_seed)
        comparison = compare_runs(
            baseline,
            candidate,
            n_resamples=n_resamples,
            seed=stable_u64("cmp", label, str(pair_index)) % 2**32,
        )
        deltas.append(comparison.aggregate.diff)
        if comparison.aggregate.ci.lo > 0.0:
            improvements += 1
        verdicts = [
            gate_naive(comparison, NAIVE_THRESHOLDS[0]),
            gate_naive(comparison, NAIVE_THRESHOLDS[1]),
            gate_ci(comparison),
            gate_slice(comparison),
            gate_combined(comparison),
        ]
        for verdict in verdicts:
            if not verdict.passed:
                fails[verdict.gate] += 1
    return GateRates(
        n_pairs=n_pairs,
        mean_delta=sum(deltas) / len(deltas),
        min_delta=min(deltas),
        max_delta=max(deltas),
        fail_rates={name: count / n_pairs for name, count in fails.items()},
        improve_rate=improvements / n_pairs,
    )


def power_curve(
    baseline_model: ScriptedModel,
    candidate_model: ScriptedModel,
    sizes: tuple[int, ...],
    n_pairs: int,
    n_resamples: int,
    datagen_seed: int,
) -> list[PowerPoint]:
    """ci-gate detection rate as the golden set grows.

    Each size gets its own synthetic golden set (same templates, one
    fixed generation seed per size), held fixed across all seed pairs:
    the eval set is a constant of the pipeline, the runs vary.
    """
    points = []
    for size in sizes:
        if size % 6 != 0:
            raise ValueError(f"size {size} must be divisible by the 6 categories")
        items = build_golden_items(
            per_category=size // 6, seed=datagen_seed + size
        )
        detected = 0
        for pair_index, (base_seed, cand_seed) in enumerate(
            _pair_seeds(n_pairs, f"power-{size}")
        ):
            baseline = run_eval(baseline_model, items, base_seed)
            candidate = run_eval(candidate_model, items, cand_seed)
            comparison = compare_runs(
                baseline,
                candidate,
                n_resamples=n_resamples,
                seed=stable_u64("power", str(size), str(pair_index)) % 2**32,
            )
            if not gate_ci(comparison).passed:
                detected += 1
        points.append(PowerPoint(n_items=size, detection_rate=detected / n_pairs))
    return points
