"""Measure the gates against scenarios with known ground truth.

Because the model versions are authored, every comparison here has a
true answer: baseline vs baseline is noise and a gate that fails it is
false-alarming, baseline vs a regressed version is real and a gate that
passes it missed. Repeating each comparison over many seed pairs turns
the gate verdicts into rates, and generating larger synthetic golden
sets turns the ci gate's detection rate into a power curve over eval
set size.

Those rates are themselves sampled: a rate over n_pairs comparisons is
a binomial proportion, and at these pair counts the interval around it
is wide. Every rate here carries its Wilson interval for the same
reason the gates carry one on the eval delta — a point estimate quoted
without one is the error this project exists to name.

The corrected slice gates are nested inside the plain one (a slice that
clears the Bonferroni cut also clears the uncorrected level), so what
correction costs is a paired count, not a difference of two marginal
proportions. `discordance` records it directly: the pairs the plain
gate flagged and the corrected gate let through, and the reverse.
"""

import math
from dataclasses import dataclass

from .compare import compare_runs, gate_ci, gate_combined, gate_naive, gate_slice
from .correction import gate_combined_bh, gate_slice_bh, gate_slice_bonferroni
from .data import GoldenItem
from .datagen import build_golden_items
from .harness import run_eval
from .model import ScriptedModel, stable_u64

NAIVE_THRESHOLDS = (0.01, 0.02)

# Two-sided 95% normal quantile, matching the bootstrap intervals' level.
Z_95 = 1.959963984540054

# The corrected gates and the plain slice gate they are corrections of.
CORRECTED_GATES = (("slice-bonf", "slice"), ("slice-bh", "slice"))

GATE_NAMES = (
    "naive-0.01",
    "naive-0.02",
    "ci",
    "slice",
    "slice-bonf",
    "slice-bh",
    "ci+slice",
    "ci+slice-bh",
)


def wilson_interval(
    successes: int, n: int, z: float = Z_95
) -> tuple[float, float]:
    """Wilson score interval for a binomial proportion.

    Preferred over the normal approximation because these rates sit near
    0 and 1 at small n, exactly where the textbook interval runs off the
    end of [0, 1] and gets narrow when it should be wide.
    """
    if n < 1:
        raise ValueError(f"n must be >= 1, got {n}")
    if not 0 <= successes <= n:
        raise ValueError(f"successes must be in [0, {n}], got {successes}")
    p = successes / n
    denominator = 1.0 + z * z / n
    center = (p + z * z / (2 * n)) / denominator
    half = (z / denominator) * math.sqrt(
        p * (1 - p) / n + z * z / (4 * n * n)
    )
    return (max(0.0, center - half), min(1.0, center + half))


@dataclass(frozen=True)
class GateRates:
    n_pairs: int
    mean_delta: float
    min_delta: float
    max_delta: float
    fail_counts: dict[str, int]  # gate name -> pairs failed
    fail_rates: dict[str, float]  # gate name -> fraction of pairs failed
    fail_intervals: dict[str, tuple[float, float]]  # 95% on each rate
    # corrected gate -> (pairs the plain gate flagged and it did not,
    # pairs it flagged and the plain gate did not)
    discordance: dict[str, tuple[int, int]]
    improve_count: int  # pairs whose aggregate ci sits above zero
    improve_rate: float
    improve_interval: tuple[float, float]


@dataclass(frozen=True)
class PowerPoint:
    n_items: int
    detected: int  # pairs where the ci gate fails
    detection_rate: float
    interval: tuple[float, float]  # 95% on detection_rate


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
    discordance = {corrected: [0, 0] for corrected, _ in CORRECTED_GATES}
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
            gate_slice_bonferroni(comparison),
            gate_slice_bh(comparison),
            gate_combined(comparison),
            gate_combined_bh(comparison),
        ]
        failed = {v.gate: not v.passed for v in verdicts}
        for verdict in verdicts:
            if not verdict.passed:
                fails[verdict.gate] += 1
        for corrected, plain in CORRECTED_GATES:
            if failed[plain] and not failed[corrected]:
                discordance[corrected][0] += 1
            elif failed[corrected] and not failed[plain]:
                discordance[corrected][1] += 1
    return GateRates(
        n_pairs=n_pairs,
        mean_delta=sum(deltas) / len(deltas),
        min_delta=min(deltas),
        max_delta=max(deltas),
        fail_counts=dict(fails),
        fail_rates={name: count / n_pairs for name, count in fails.items()},
        fail_intervals={
            name: wilson_interval(count, n_pairs) for name, count in fails.items()
        },
        discordance={
            name: (spared, added) for name, (spared, added) in discordance.items()
        },
        improve_count=improvements,
        improve_rate=improvements / n_pairs,
        improve_interval=wilson_interval(improvements, n_pairs),
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
        points.append(
            PowerPoint(
                n_items=size,
                detected=detected,
                detection_rate=detected / n_pairs,
                interval=wilson_interval(detected, n_pairs),
            )
        )
    return points
