"""Eval regression gating, measured against known ground truth.

Runs the committed 240-item golden set through four scripted model
versions, persists and reloads run records the way a CI pipeline
stores eval artifacts, then measures the gate families (naive
threshold, paired-bootstrap ci, per-slice ci, and the slice gate under
bonferroni and benjamini-hochberg correction) on the four situations a
gate faces: pure rerun noise, a slice regression sized to vanish from
the aggregate, a small uniform drift, and a true improvement. Finishes
with a power curve: how large the golden set must be before the ci
gate reliably sees a 3-point regression.

Deterministic end to end: seeded data, seeded outcome draws, seeded
bootstrap. Same output every run."""

from pathlib import Path

from eval_harness.compare import (
    compare_runs,
    gate_ci,
    gate_combined,
    gate_naive,
    gate_slice,
)
from eval_harness.correction import (
    gate_combined_bh,
    gate_slice_bh,
    gate_slice_bonferroni,
)
from eval_harness.data import dataset_fingerprint, load_golden
from eval_harness.experiments import (
    CORRECTED_GATES,
    GATE_NAMES,
    GateRates,
    measure_gate_rates,
    power_curve,
)
from eval_harness.harness import load_run, run_eval, save_run
from eval_harness.model import BASELINE, DRIFT, IMPROVED, MASKED_REGRESSION

GOLDEN_PATH = Path(__file__).parent / "data" / "golden.jsonl"
RUNS_DIR = Path(__file__).parent / "runs"

HEADLINE_RESAMPLES = 10_000
SWEEP_PAIRS = 50
SWEEP_RESAMPLES = 500
POWER_SIZES = (240, 960, 3840)
POWER_PAIRS = 30
POWER_RESAMPLES = 300
POWER_DATAGEN_SEED = 7000


def print_headline(items) -> None:
    print("== headline comparison: baseline-1.0 vs masked-2.0, one run each ==")
    baseline = run_eval(BASELINE, items, eval_seed=11)
    save_run(baseline, RUNS_DIR / "baseline-1.0.json")
    stored = load_run(RUNS_DIR / "baseline-1.0.json")
    candidate = run_eval(MASKED_REGRESSION, items, eval_seed=12)
    save_run(candidate, RUNS_DIR / "masked-2.0.json")
    comparison = compare_runs(stored, candidate, n_resamples=HEADLINE_RESAMPLES)

    print(
        f"aggregate accuracy: {comparison.baseline_accuracy:.4f} -> "
        f"{comparison.candidate_accuracy:.4f} "
        f"(delta {comparison.aggregate.diff:+.4f}, 95% ci "
        f"[{comparison.aggregate.ci.lo:+.4f}, {comparison.aggregate.ci.hi:+.4f}])"
    )
    flips = comparison.flips
    print(
        f"flips over {comparison.n_items} items: "
        f"{flips.both_correct} both correct, {flips.both_wrong} both wrong, "
        f"{flips.fixed} fixed, {flips.broken} broken"
    )
    print("per category (candidate minus baseline; p is bootstrap p_ge_zero):")
    for cat in comparison.categories:
        ci = cat.comparison.ci
        print(
            f"  {cat.category:<10} n={cat.n_items}  "
            f"{cat.baseline_accuracy:.4f} -> {cat.candidate_accuracy:.4f}  "
            f"delta {cat.comparison.diff:+.4f}  ci [{ci.lo:+.4f}, {ci.hi:+.4f}]  "
            f"p={cat.comparison.p_ge_zero:.4f}"
        )
    for verdict in (
        gate_naive(comparison, 0.01),
        gate_naive(comparison, 0.02),
        gate_ci(comparison),
        gate_slice(comparison),
        gate_slice_bonferroni(comparison),
        gate_slice_bh(comparison),
        gate_combined(comparison),
        gate_combined_bh(comparison),
    ):
        state = "pass" if verdict.passed else "FAIL"
        print(f"gate {verdict.gate:<11} {state}  ({verdict.reason})")
    print()


def print_rates(title: str, truth: str, rates: GateRates) -> None:
    print(f"== {title} ==")
    print(
        f"{rates.n_pairs} seed pairs, aggregate delta mean {rates.mean_delta:+.4f}, "
        f"range [{rates.min_delta:+.4f}, {rates.max_delta:+.4f}]"
    )
    print(f"ground truth: {truth}")
    for name in GATE_NAMES:
        lo, hi = rates.fail_intervals[name]
        print(
            f"  {name:<11} fails {rates.fail_rates[name]:>5.1%} of pairs "
            f"({rates.fail_counts[name]}/{rates.n_pairs}, 95% ci "
            f"[{lo:.1%}, {hi:.1%}])"
        )
    lo, hi = rates.improve_interval
    print(
        f"  improvement confirmed (ci above zero) in {rates.improve_rate:.1%} "
        f"({rates.improve_count}/{rates.n_pairs}, 95% ci [{lo:.1%}, {hi:.1%}])"
    )
    for corrected, plain in CORRECTED_GATES:
        spared, added = rates.discordance[corrected]
        print(
            f"  paired: {corrected} spares {spared} of the "
            f"{rates.fail_counts[plain]} pairs {plain} flagged, adds {added}"
        )
    print()


def main() -> None:
    items = load_golden(GOLDEN_PATH)
    categories = sorted({item.category for item in items})
    print(
        f"golden set: {len(items)} items, {len(categories)} categories, "
        f"fingerprint {dataset_fingerprint(items)[:12]}"
    )
    print()

    print_headline(items)

    print_rates(
        "noise only: baseline-1.0 vs itself, different eval seeds",
        "no change; every gate failure is a false alarm",
        measure_gate_rates(
            items, BASELINE, BASELINE, SWEEP_PAIRS, SWEEP_RESAMPLES, "noise"
        ),
    )
    print_rates(
        "masked slice regression: baseline-1.0 vs masked-2.0",
        "date drops 24 points, five categories gain 4.8; aggregate unchanged "
        "by construction; a gate that passes this missed a real regression",
        measure_gate_rates(
            items,
            BASELINE,
            MASKED_REGRESSION,
            SWEEP_PAIRS,
            SWEEP_RESAMPLES,
            "masked",
        ),
    )
    print_rates(
        "small uniform drift: baseline-1.0 vs drift-1.1",
        "every category drops 3 points; real regression",
        measure_gate_rates(
            items, BASELINE, DRIFT, SWEEP_PAIRS, SWEEP_RESAMPLES, "drift"
        ),
    )
    print_rates(
        "true improvement: baseline-1.0 vs improved-3.0",
        "every category gains 4 points; every gate failure is a false alarm",
        measure_gate_rates(
            items, BASELINE, IMPROVED, SWEEP_PAIRS, SWEEP_RESAMPLES, "improved"
        ),
    )

    print("== power curve: ci-gate detection of the 3-point drift vs eval size ==")
    print(
        f"({POWER_PAIRS} seed pairs per size, synthetic golden sets from the "
        "same templates)"
    )
    for point in power_curve(
        BASELINE,
        DRIFT,
        POWER_SIZES,
        POWER_PAIRS,
        POWER_RESAMPLES,
        POWER_DATAGEN_SEED,
    ):
        lo, hi = point.interval
        print(
            f"  n={point.n_items:<5} detection {point.detection_rate:.1%} "
            f"({point.detected}/{POWER_PAIRS}, 95% ci [{lo:.1%}, {hi:.1%}])"
        )
    print()


if __name__ == "__main__":
    main()
