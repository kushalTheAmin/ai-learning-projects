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

from eval_harness.experiments import wilson_interval

README = (Path(__file__).resolve().parents[1] / "README.md").read_text(
    encoding="utf-8"
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
