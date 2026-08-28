"""Compare two run records and gate the candidate.

The comparison is paired: both runs scored the same items, so the
statistics resample per-item correctness differences (02's paired
bootstrap), which keeps the coupling between runs instead of treating
them as independent samples. Three gate families sit on top:

- naive: fail when the aggregate accuracy drops more than a fixed
  threshold. No notion of noise at all.
- ci: fail when the 95% bootstrap interval on the aggregate difference
  sits entirely below zero, meaning the regression survived resampling.
- slice: the ci rule applied per category, failing if any category's
  interval sits below zero. Catches regressions the aggregate hides,
  at the price of testing six intervals per comparison.
"""

from dataclasses import dataclass

from .harness import RunRecord
from .model import stable_u64
from .reuse import PairedComparison, paired_bootstrap


@dataclass(frozen=True)
class FlipTable:
    both_correct: int
    both_wrong: int
    fixed: int  # wrong in baseline, correct in candidate
    broken: int  # correct in baseline, wrong in candidate


@dataclass(frozen=True)
class CategoryDelta:
    category: str
    n_items: int
    baseline_accuracy: float
    candidate_accuracy: float
    comparison: PairedComparison  # candidate minus baseline


@dataclass(frozen=True)
class RunComparison:
    baseline_model: str
    candidate_model: str
    n_items: int
    baseline_accuracy: float
    candidate_accuracy: float
    aggregate: PairedComparison  # candidate minus baseline
    flips: FlipTable
    categories: tuple[CategoryDelta, ...]


@dataclass(frozen=True)
class GateVerdict:
    gate: str
    passed: bool
    reason: str


def compare_runs(
    baseline: RunRecord,
    candidate: RunRecord,
    n_resamples: int = 10_000,
    seed: int = 0,
) -> RunComparison:
    if baseline.fingerprint != candidate.fingerprint:
        raise ValueError(
            "runs were scored on different datasets "
            f"({baseline.fingerprint[:12]} vs {candidate.fingerprint[:12]}); "
            "a paired comparison would be meaningless"
        )
    base_ids = [o.item_id for o in baseline.outcomes]
    cand_ids = [o.item_id for o in candidate.outcomes]
    if base_ids != cand_ids:
        raise ValueError("runs hold different item sequences despite one fingerprint")

    base_vals = [1.0 if o.correct else 0.0 for o in baseline.outcomes]
    cand_vals = [1.0 if o.correct else 0.0 for o in candidate.outcomes]
    aggregate = paired_bootstrap(
        cand_vals, base_vals, n_resamples=n_resamples, seed=seed
    )

    flips = FlipTable(
        both_correct=sum(
            1 for b, c in zip(base_vals, cand_vals) if b == 1.0 and c == 1.0
        ),
        both_wrong=sum(
            1 for b, c in zip(base_vals, cand_vals) if b == 0.0 and c == 0.0
        ),
        fixed=sum(1 for b, c in zip(base_vals, cand_vals) if b == 0.0 and c == 1.0),
        broken=sum(1 for b, c in zip(base_vals, cand_vals) if b == 1.0 and c == 0.0),
    )

    categories = []
    for category in sorted({o.category for o in baseline.outcomes}):
        indexes = [
            i for i, o in enumerate(baseline.outcomes) if o.category == category
        ]
        sub_base = [base_vals[i] for i in indexes]
        sub_cand = [cand_vals[i] for i in indexes]
        categories.append(
            CategoryDelta(
                category=category,
                n_items=len(indexes),
                baseline_accuracy=sum(sub_base) / len(sub_base),
                candidate_accuracy=sum(sub_cand) / len(sub_cand),
                comparison=paired_bootstrap(
                    sub_cand,
                    sub_base,
                    n_resamples=n_resamples,
                    seed=stable_u64("slice", category, str(seed)) % 2**32,
                ),
            )
        )

    return RunComparison(
        baseline_model=baseline.model_name,
        candidate_model=candidate.model_name,
        n_items=len(base_vals),
        baseline_accuracy=baseline.accuracy,
        candidate_accuracy=candidate.accuracy,
        aggregate=aggregate,
        flips=flips,
        categories=tuple(categories),
    )


def gate_naive(comparison: RunComparison, max_drop: float) -> GateVerdict:
    """Fail iff aggregate accuracy dropped by more than max_drop points."""
    if max_drop < 0:
        raise ValueError(f"max_drop must be >= 0, got {max_drop}")
    delta = comparison.aggregate.diff
    passed = delta >= -max_drop
    return GateVerdict(
        gate=f"naive-{max_drop:g}",
        passed=passed,
        reason=f"aggregate delta {delta:+.4f} vs allowed drop {max_drop:g}",
    )


def gate_ci(comparison: RunComparison) -> GateVerdict:
    """Fail iff the aggregate 95% interval sits entirely below zero."""
    ci = comparison.aggregate.ci
    passed = ci.hi >= 0.0
    return GateVerdict(
        gate="ci",
        passed=passed,
        reason=f"aggregate delta {comparison.aggregate.diff:+.4f}, "
        f"95% ci [{ci.lo:+.4f}, {ci.hi:+.4f}]",
    )


def gate_slice(comparison: RunComparison) -> GateVerdict:
    """Fail iff any category's 95% interval sits entirely below zero."""
    failing = [
        c.category for c in comparison.categories if c.comparison.ci.hi < 0.0
    ]
    if failing:
        details = ", ".join(
            f"{c.category} {c.comparison.diff:+.4f} "
            f"[{c.comparison.ci.lo:+.4f}, {c.comparison.ci.hi:+.4f}]"
            for c in comparison.categories
            if c.category in failing
        )
        return GateVerdict(
            gate="slice", passed=False, reason=f"regressed slices: {details}"
        )
    return GateVerdict(
        gate="slice", passed=True, reason="no category interval sits below zero"
    )


def gate_combined(comparison: RunComparison) -> GateVerdict:
    """Fail iff the ci gate or the slice gate fails."""
    ci = gate_ci(comparison)
    slices = gate_slice(comparison)
    passed = ci.passed and slices.passed
    reason = ci.reason if not ci.passed else slices.reason
    return GateVerdict(gate="ci+slice", passed=passed, reason=reason)
