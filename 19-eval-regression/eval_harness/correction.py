"""Multiple-comparison correction for the slice gate.

The plain slice gate reads six 95% intervals per comparison, so even on
pure rerun noise it gets six chances to false-alarm. Its per-slice test
is one-sided at alpha 0.025 (the upper end of a two-sided 95% interval
sitting below zero), which compounds to roughly 1 - 0.975^6 = 14% of
comparisons flagged with nothing wrong.

Both corrections here work on per-slice bootstrap p-values: a slice's
p is p_ge_zero, the fraction of resamples where its delta came out at
or above zero — small p means the regression survived resampling.
This is a bootstrap direction fraction pressed into service as a
p-value, not an exact test; whether it behaves is exactly what the
measured false-alarm rates check.

- Bonferroni splits the alpha budget evenly: a slice fails only at
  p <= alpha / m. Controls the family-wise error rate, the price is
  power on diffuse signals.
- Benjamini-Hochberg steps up through the sorted p-values, letting
  rank k spend k * alpha / m. Controls the false discovery rate,
  sitting between uncorrected and Bonferroni.
"""

from .compare import GateVerdict, RunComparison, gate_ci

# The plain slice gate's implied per-slice one-sided level: a two-sided
# 95% interval below zero is the 0.975 percentile below zero. Using the
# same budget here isolates the correction as the only change.
ALPHA_ONE_SIDED = 0.025


def benjamini_hochberg(p_values: list[float], q: float) -> list[bool]:
    """Step-up BH rejection flags, index-aligned with p_values.

    Sort ascending, find the largest rank k with p_(k) <= k * q / m,
    reject ranks 1..k. Ties are safe without special casing: equal
    p-values at adjacent ranks pass or fail together because the
    threshold grows with rank.
    """
    if not 0.0 < q < 1.0:
        raise ValueError(f"q must be in (0, 1), got {q}")
    for p in p_values:
        if not 0.0 <= p <= 1.0:
            raise ValueError(f"p-values must be in [0, 1], got {p}")
    m = len(p_values)
    order = sorted(range(m), key=lambda i: p_values[i])
    k_star = 0
    for rank, i in enumerate(order, start=1):
        if p_values[i] <= rank * q / m:
            k_star = rank
    rejected = [False] * m
    for rank, i in enumerate(order, start=1):
        if rank <= k_star:
            rejected[i] = True
    return rejected


def _failure_verdict(gate: str, comparison: RunComparison, failing: list[str]) -> GateVerdict:
    details = ", ".join(
        f"{c.category} {c.comparison.diff:+.4f} p={c.comparison.p_ge_zero:.4f}"
        for c in comparison.categories
        if c.category in failing
    )
    return GateVerdict(gate=gate, passed=False, reason=f"regressed slices: {details}")


def gate_slice_bonferroni(
    comparison: RunComparison, alpha: float = ALPHA_ONE_SIDED
) -> GateVerdict:
    """Fail iff any slice's p_ge_zero clears the Bonferroni cut alpha/m."""
    if not 0.0 < alpha < 1.0:
        raise ValueError(f"alpha must be in (0, 1), got {alpha}")
    cut = alpha / len(comparison.categories)
    failing = [
        c.category for c in comparison.categories if c.comparison.p_ge_zero <= cut
    ]
    if failing:
        return _failure_verdict("slice-bonf", comparison, failing)
    return GateVerdict(
        gate="slice-bonf",
        passed=True,
        reason=f"no slice p-value at or below {cut:.4f}",
    )


def gate_slice_bh(
    comparison: RunComparison, q: float = ALPHA_ONE_SIDED
) -> GateVerdict:
    """Fail iff Benjamini-Hochberg at q rejects any slice."""
    p_values = [c.comparison.p_ge_zero for c in comparison.categories]
    rejected = benjamini_hochberg(p_values, q)
    failing = [
        c.category
        for c, is_rejected in zip(comparison.categories, rejected)
        if is_rejected
    ]
    if failing:
        return _failure_verdict("slice-bh", comparison, failing)
    return GateVerdict(
        gate="slice-bh",
        passed=True,
        reason=f"benjamini-hochberg at q={q:g} rejects no slice",
    )


def gate_combined_bh(comparison: RunComparison) -> GateVerdict:
    """Fail iff the aggregate ci gate or the BH slice gate fails."""
    ci = gate_ci(comparison)
    slices = gate_slice_bh(comparison)
    passed = ci.passed and slices.passed
    reason = ci.reason if not ci.passed else slices.reason
    return GateVerdict(gate="ci+slice-bh", passed=passed, reason=reason)
