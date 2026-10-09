"""Holds the published gate rates, and the readme sentences about them, to
what the entry point actually measures.

Every rate in the readme's gate table is a proportion over SWEEP_PAIRS
comparisons, so it carries binomial uncertainty like any other sampled
number. These tests pin the intervals the entry point now prints, the
paired counts that carry the correction claim, and the readme text that
quotes them.
"""

import re
from pathlib import Path

import pytest

from eval_harness.compare import (
    compare_runs,
    gate_ci,
    gate_naive,
    gate_slice,
)
from eval_harness.correction import gate_slice_bh, gate_slice_bonferroni
from eval_harness.data import load_golden
from eval_harness.experiments import _pair_seeds, wilson_interval
from eval_harness.harness import run_eval
from eval_harness.model import BASELINE, IMPROVED, stable_u64

ROOT = Path(__file__).resolve().parents[1]
README = (ROOT / "README.md").read_text(encoding="utf-8")

SWEEP_RESAMPLES = 500


def _improved_pair(pair_index: int):
    """One comparison from the improved sweep, exactly as main.py runs it."""
    items = load_golden(ROOT / "data" / "golden.jsonl")
    base_seed, cand_seed = _pair_seeds(50, "improved")[pair_index]
    return compare_runs(
        run_eval(BASELINE, items, base_seed),
        run_eval(IMPROVED, items, cand_seed),
        n_resamples=SWEEP_RESAMPLES,
        seed=stable_u64("cmp", "improved", str(pair_index)) % 2**32,
    )


class TestWilsonInterval:
    """The interval itself, against values computable by hand."""

    def test_half_of_a_hundred(self):
        lo, hi = wilson_interval(50, 100)
        assert (round(lo, 4), round(hi, 4)) == (0.4038, 0.5962)

    def test_three_of_fifty(self):
        # the ci gate's drift cell: a 6.0% point estimate whose interval
        # reaches past 16%
        lo, hi = wilson_interval(3, 50)
        assert (round(lo, 4), round(hi, 4)) == (0.0206, 0.1622)

    def test_zero_successes_starts_at_zero(self):
        lo, hi = wilson_interval(0, 50)
        assert lo == 0.0
        assert 0.0 < hi < 0.1

    def test_all_successes_ends_at_one(self):
        lo, hi = wilson_interval(50, 50)
        assert hi == 1.0
        assert 0.9 < lo < 1.0

    def test_interval_brackets_the_point_estimate(self):
        for successes in range(0, 51):
            lo, hi = wilson_interval(successes, 50)
            assert lo <= successes / 50 <= hi

    def test_more_samples_narrow_the_interval(self):
        narrow = wilson_interval(120, 400)
        wide = wilson_interval(15, 50)
        assert (wide[1] - wide[0]) > (narrow[1] - narrow[0])

    def test_rejects_impossible_counts(self):
        with pytest.raises(ValueError, match="successes"):
            wilson_interval(51, 50)
        with pytest.raises(ValueError, match="n must be"):
            wilson_interval(0, 0)


class TestPublishedRatesCarryTheirUncertainty:
    """The specific contradiction that started this: the readme quoted the
    ci gate's drift detection as 6.0% in the table and 23.3% in the power
    curve, two draws of one quantity, and waved the gap away."""

    def test_the_two_drift_cells_agree_once_bracketed(self):
        table_cell = wilson_interval(3, 50)  # 6.0% over 50 sweep pairs
        power_cell = wilson_interval(7, 30)  # 23.3% over 30 power pairs
        assert table_cell[0] < power_cell[1] and power_cell[0] < table_cell[1]

    def test_the_point_estimates_alone_look_incompatible(self):
        # 6.0% and 23.3% are a factor of four apart; only the intervals
        # reconcile them, which is why the bare cells were misleading
        assert (7 / 30) / (3 / 50) > 3.5

    def test_readme_brackets_the_ci_gate_drift_cell(self):
        assert "6.0% [2.1%, 16.2%]" in README

    def test_readme_brackets_the_power_curve_first_point(self):
        assert "23.3% [11.8%, 40.9%]" in README

    def test_readme_no_longer_calls_the_gap_a_seed_difference(self):
        # the readme wraps, so match against the unwrapped text
        assert (
            "same quantity at different sweep seeds"
            not in re.sub(r"\s+", " ", README)
        )

    def test_every_rate_table_cell_carries_an_interval(self):
        rows = [
            line
            for line in README.splitlines()
            if line.startswith("| ") and "%" in line
        ]
        assert rows, "expected the gate rate table to still be in the readme"
        for row in rows:
            cells = [c.strip() for c in row.strip("|").split("|")][1:]
            for cell in cells:
                assert re.fullmatch(
                    r"\d+\.\d% \[\d+\.\d%, \d+\.\d%\]", cell
                ), f"bare rate cell {cell!r} in row {row!r}"


class TestCorrectionCostIsPaired:
    """The corrected gates are nested inside the plain slice gate, so the
    cost of correction is a paired count, not a difference of two
    independent proportions whose intervals happen to overlap."""

    def test_marginal_intervals_alone_would_not_establish_the_trade(self):
        plain = wilson_interval(34, 50)  # 68.0%
        corrected = wilson_interval(25, 50)  # 50.0%
        assert corrected[1] > plain[0], (
            "the marginal intervals overlap, so the 68 -> 50 trade is only "
            "established by the pairing"
        )

    def test_readme_quotes_the_paired_count(self):
        assert "9 of the 34" in README

    def test_readme_keeps_the_headline_trade(self):
        assert "68.0%" in README and "50.0%" in README


class TestImprovementRowIsNotAllPass:
    """The improvement row of the gate table has three non-zero cells: the
    slice gate blocks a true 4-point improvement on 3 of 50 pairs and both
    naive gates on 1 of 50. Summarizing the row as everything passing
    erases a measured false alarm rate, which is the one thing this project
    is about."""

    def test_readme_does_not_claim_everything_passes(self):
        # the fixes section quotes the retired sentence on purpose, so the
        # check is on the live prose above it
        live = re.sub(r"\s+", " ", README.split("## fixes")[0])
        assert "everything passes the improvement" not in live

    def test_readme_quotes_the_slice_gates_improvement_false_alarms(self):
        flat = re.sub(r"\s+", " ", README)
        assert "6.0% [2.1%, 16.2%] of pairs (3 of 50)" in flat

    def test_readme_quotes_the_naive_gates_improvement_false_alarms(self):
        flat = re.sub(r"\s+", " ", README)
        assert "2.0% [0.4%, 10.5%] (1 of 50)" in flat

    def test_readme_names_the_gates_that_are_actually_clean(self):
        flat = re.sub(r"\s+", " ", README)
        assert (
            "only the ci gate and the two corrected slice gates sit at "
            "0.0% [0.0%, 7.1%]" in flat
        )

    def test_the_three_cells_are_the_intervals_the_readme_quotes(self):
        slice_cell = wilson_interval(3, 50)
        naive_cell = wilson_interval(1, 50)
        clean_cell = wilson_interval(0, 50)
        assert (round(slice_cell[0], 3), round(slice_cell[1], 3)) == (0.021, 0.162)
        assert (round(naive_cell[0], 3), round(naive_cell[1], 3)) == (0.004, 0.105)
        assert (round(clean_cell[0], 3), round(clean_cell[1], 3)) == (0.0, 0.071)


class TestGatesReallyDoBlockTheImprovement:
    """The false alarms above are real comparisons, not a table artifact.
    Two seed pairs out of the improved sweep's fifty, pinned by hand."""

    def test_slice_gate_flags_a_category_that_truly_improved(self):
        comparison = _improved_pair(30)
        assert comparison.aggregate.diff > 0.0
        verdict = gate_slice(comparison)
        assert not verdict.passed
        # improved-3.0 gains 4 points in every category, so every slice
        # named here is a false alarm, and two of six landed at once
        assert "arithmetic" in verdict.reason
        assert "date" in verdict.reason

    def test_corrected_gates_let_that_same_pair_through(self):
        comparison = _improved_pair(30)
        assert gate_slice_bonferroni(comparison).passed
        assert gate_slice_bh(comparison).passed

    def test_naive_gate_blocks_a_better_model_on_a_negative_draw(self):
        comparison = _improved_pair(37)
        assert comparison.aggregate.diff < -0.01
        assert not gate_naive(comparison, 0.01).passed
        # the honest gate reads the same draw as noise, which it is
        assert gate_ci(comparison).passed


class TestCorrectionCostIsOneBinomial:
    """The sign test the readme quoted cannot be the basis of the trade.

    A sign test asks how surprising it is that every discordant pair fell
    the same way, under a null where either direction was equally likely.
    Nesting makes the other direction impossible: a slice clearing the
    bonferroni cut has already cleared the uncorrected level, so a pair the
    corrected gate flags is always a pair the plain gate flagged. All one
    direction is therefore certain given the count, whatever the truth, and
    p = 2^-9 measured nothing.

    What is sampled is the count itself. Nesting also makes that count the
    entire marginal difference, so the 68 -> 50 trade is one binomial
    proportion and carries one Wilson interval like every other rate here.
    """

    def test_bonferroni_firing_forces_the_plain_interval_below_zero(self):
        # Structural, not empirical: if at most alpha/m of the resampled
        # slice deltas land at or above zero, the 97.5th percentile the
        # plain gate reads cannot be one of them, at any resample count.
        from eval_harness.correction import ALPHA_ONE_SIDED
        from eval_harness.reuse import ConfidenceInterval  # noqa: F401
        from retrieval_eval.bootstrap import percentile

        cut = ALPHA_ONE_SIDED / 6
        for n in (200, 300, 400, 500, 2000, 10_000):
            for k in range(0, int(cut * n) + 1):
                # worst case for the plain gate: every resample that is not
                # below zero sits at the very top of the sorted stats
                stats = [-1.0] * (n - k) + [0.0] * k
                p_ge_zero = k / n
                assert p_ge_zero <= cut
                assert percentile(stats, 0.975) < 0.0, (
                    f"n={n} k={k}: bonferroni would fire where the plain "
                    "slice gate does not, so the gates are not nested"
                )

    def test_discordance_rate_is_the_whole_marginal_difference(self):
        # nesting, read off the published sweep: every scenario's spared
        # count over 50 pairs equals plain minus corrected, exactly
        from eval_harness.data import load_golden
        from eval_harness.experiments import CORRECTED_GATES, measure_gate_rates
        from eval_harness.model import BASELINE, MASKED_REGRESSION

        items = load_golden(ROOT / "data" / "golden.jsonl")
        rates = measure_gate_rates(
            items, BASELINE, MASKED_REGRESSION, 50, SWEEP_RESAMPLES, "masked"
        )
        for corrected, plain in CORRECTED_GATES:
            spared, added = rates.discordance[corrected]
            assert added == 0
            assert rates.discordance_rate[corrected] == spared / rates.n_pairs
            # exact in counts, which is where the identity actually lives
            assert spared == (
                rates.fail_counts[plain] - rates.fail_counts[corrected]
            )
            assert rates.discordance_rate[corrected] == pytest.approx(
                rates.fail_rates[plain] - rates.fail_rates[corrected]
            )
            lo, hi = rates.discordance_interval[corrected]
            assert (lo, hi) == wilson_interval(spared, rates.n_pairs)
            assert lo <= rates.discordance_rate[corrected] <= hi
            # the cost survives its own interval, which is the real claim
            assert lo > 0.0

    def test_readme_no_longer_quotes_the_sign_test(self):
        flat = re.sub(r"\s+", " ", README.split("## fixes")[0])
        assert "sign test" not in flat
        assert "2^-9" not in flat

    def test_readme_brackets_the_correction_cost(self):
        flat = re.sub(r"\s+", " ", README)
        # the 68.0 -> 50.0 trade, as the one binomial it actually is
        assert "18.0% [9.8%, 30.8%]" in flat
