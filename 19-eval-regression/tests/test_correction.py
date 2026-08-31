import dataclasses

import pytest

from eval_harness.compare import (
    CategoryDelta,
    FlipTable,
    RunComparison,
    compare_runs,
    gate_slice,
)
from eval_harness.correction import (
    ALPHA_ONE_SIDED,
    benjamini_hochberg,
    gate_combined_bh,
    gate_slice_bh,
    gate_slice_bonferroni,
)
from eval_harness.data import CATEGORIES
from eval_harness.harness import run_eval
from eval_harness.model import BASELINE, ScriptedModel
from eval_harness.reuse import ConfidenceInterval, PairedComparison
from tests.test_compare import items_for

RESAMPLES = 400

SURE = ScriptedModel(name="sure", skills={c: 1.0 for c in CATEGORIES})
LOST = ScriptedModel(name="lost", skills={c: 0.0 for c in CATEGORIES})


class TestBenjaminiHochberg:
    def test_textbook_example(self):
        # thresholds at q=0.05 over 6 tests: 0.0083, 0.0167, 0.025, ...
        # ranks 1 and 2 pass, rank 3 (0.039 > 0.025) breaks the run and
        # no later rank recovers, so exactly the two smallest are rejected
        p = [0.039, 0.001, 0.041, 0.008, 0.042, 0.06]
        assert benjamini_hochberg(p, 0.05) == [False, True, False, True, False, False]

    def test_step_up_rescues_below_a_passing_rank(self):
        # rank 4 (0.02 <= 4*0.05/4=0.05) passes, so ranks 1..3 are
        # rejected too even though 0.02 alone fails the rank-1 cut 0.0125
        p = [0.02, 0.02, 0.02, 0.02]
        assert benjamini_hochberg(p, 0.05) == [True] * 4

    def test_all_ones_rejects_nothing(self):
        assert benjamini_hochberg([1.0] * 6, 0.05) == [False] * 6

    def test_all_zeros_rejects_everything(self):
        assert benjamini_hochberg([0.0] * 6, 0.05) == [True] * 6

    def test_single_p_value_is_a_plain_alpha_test(self):
        assert benjamini_hochberg([0.04], 0.05) == [True]
        assert benjamini_hochberg([0.06], 0.05) == [False]

    def test_empty_input_returns_empty(self):
        assert benjamini_hochberg([], 0.05) == []

    def test_rejections_are_a_superset_of_bonferroni(self):
        # BH's rank-1 threshold is the Bonferroni cut, so anything
        # Bonferroni rejects, BH must too
        cases = [
            [0.001, 0.02, 0.3, 0.5, 0.9, 1.0],
            [0.004, 0.004, 0.004, 0.9, 0.9, 0.9],
            [0.5] * 6,
            [0.0, 1.0, 0.013, 0.7, 0.012, 0.2],
        ]
        for p_values in cases:
            m = len(p_values)
            bonferroni = [p <= 0.05 / m for p in p_values]
            bh = benjamini_hochberg(p_values, 0.05)
            for bonf_rejected, bh_rejected in zip(bonferroni, bh):
                assert not bonf_rejected or bh_rejected

    def test_ties_at_the_threshold_reject_together(self):
        # both 0.025s share the value; rank 2's cut is 2*0.05/4 = 0.025,
        # so the tie passes at rank 2 and both are rejected
        p = [0.025, 0.025, 0.9, 1.0]
        assert benjamini_hochberg(p, 0.05) == [True, True, False, False]

    def test_result_ignores_input_order(self):
        p = [0.039, 0.001, 0.041, 0.008, 0.042, 0.06]
        flags = benjamini_hochberg(p, 0.05)
        reordered = list(reversed(p))
        assert benjamini_hochberg(reordered, 0.05) == list(reversed(flags))

    def test_rejects_bad_q(self):
        with pytest.raises(ValueError, match="q must be"):
            benjamini_hochberg([0.5], 0.0)
        with pytest.raises(ValueError, match="q must be"):
            benjamini_hochberg([0.5], 1.0)

    def test_rejects_out_of_range_p(self):
        with pytest.raises(ValueError, match="p-values"):
            benjamini_hochberg([0.5, 1.5], 0.05)
        with pytest.raises(ValueError, match="p-values"):
            benjamini_hochberg([-0.1], 0.05)


def comparison_with_p_values(p_values: dict[str, float]) -> RunComparison:
    """Hand-built comparison whose slices carry exact p_ge_zero values."""

    def paired(p: float) -> PairedComparison:
        return PairedComparison(
            diff=-0.1,
            ci=ConfidenceInterval(point=-0.1, lo=-0.2, hi=-0.01, confidence=0.95),
            p_le_zero=1.0,
            p_ge_zero=p,
        )

    categories = tuple(
        CategoryDelta(
            category=name,
            n_items=40,
            baseline_accuracy=0.9,
            candidate_accuracy=0.8,
            comparison=paired(p),
        )
        for name, p in sorted(p_values.items())
    )
    return RunComparison(
        baseline_model="a",
        candidate_model="b",
        n_items=40 * len(categories),
        baseline_accuracy=0.9,
        candidate_accuracy=0.8,
        aggregate=paired(0.5),
        flips=FlipTable(both_correct=0, both_wrong=0, fixed=0, broken=0),
        categories=categories,
    )


class TestCorrectedGates:
    def total_single_slice_regression(self):
        items = items_for(("unit", "date"), 20)
        base = run_eval(SURE, items, 1)
        cand_record = run_eval(SURE, items, 2)
        broken_outcomes = tuple(
            dataclasses.replace(o, correct=False, answer="wrong")
            if o.category == "date"
            else o
            for o in cand_record.outcomes
        )
        cand = dataclasses.replace(
            cand_record,
            outcomes=broken_outcomes,
            accuracy=0.5,
            category_accuracy={"date": 0.0, "unit": 1.0},
        )
        return compare_runs(base, cand, n_resamples=RESAMPLES)

    def no_change(self):
        items = items_for(("unit", "date"), 20)
        record = run_eval(BASELINE, items, 1)
        return compare_runs(record, record, n_resamples=RESAMPLES)

    def test_both_gates_fail_a_total_slice_regression(self):
        comparison = self.total_single_slice_regression()
        for verdict in (
            gate_slice_bonferroni(comparison),
            gate_slice_bh(comparison),
        ):
            assert not verdict.passed
            assert "date" in verdict.reason
            assert "unit" not in verdict.reason

    def test_both_gates_pass_no_change(self):
        comparison = self.no_change()
        assert gate_slice_bonferroni(comparison).passed
        assert gate_slice_bh(comparison).passed

    def test_bonferroni_cut_is_alpha_over_m(self):
        # 6 slices at alpha 0.025: cut 0.0041667. p=0.004 fails the
        # gate, p=0.005 survives it
        base = {c: 1.0 for c in CATEGORIES}
        failing = comparison_with_p_values({**base, "date": 0.004})
        passing = comparison_with_p_values({**base, "date": 0.005})
        assert not gate_slice_bonferroni(failing).passed
        assert gate_slice_bonferroni(passing).passed

    def test_correction_spares_a_borderline_slice_the_plain_gate_flags(self):
        # p=0.02 clears the uncorrected per-slice level 0.025 but not
        # the corrected cuts, the exact false alarm the thread priced
        base = {c: 1.0 for c in CATEGORIES}
        borderline = comparison_with_p_values({**base, "date": 0.02})
        assert gate_slice_bonferroni(borderline).passed
        assert gate_slice_bh(borderline).passed

    def test_bh_gate_rejects_diffuse_signal_bonferroni_misses(self):
        # every slice at p=0.02: BH's rank-6 cut is 6*0.025/6 = 0.025,
        # so all six are rejected; Bonferroni's cut 0.0041667 spares all
        diffuse = comparison_with_p_values({c: 0.02 for c in CATEGORIES})
        assert gate_slice_bonferroni(diffuse).passed
        verdict = gate_slice_bh(diffuse)
        assert not verdict.passed
        for category in CATEGORIES:
            assert category in verdict.reason

    def test_gate_names(self):
        comparison = self.no_change()
        assert gate_slice_bonferroni(comparison).gate == "slice-bonf"
        assert gate_slice_bh(comparison).gate == "slice-bh"
        assert gate_combined_bh(comparison).gate == "ci+slice-bh"

    def test_alpha_validation(self):
        comparison = self.no_change()
        with pytest.raises(ValueError, match="alpha"):
            gate_slice_bonferroni(comparison, alpha=0.0)
        with pytest.raises(ValueError, match="alpha"):
            gate_slice_bonferroni(comparison, alpha=1.0)

    def test_combined_bh_fails_when_either_component_fails(self):
        assert not gate_combined_bh(self.total_single_slice_regression()).passed
        assert gate_combined_bh(self.no_change()).passed

    def test_default_alpha_matches_the_plain_slice_gates_level(self):
        assert ALPHA_ONE_SIDED == 0.025

    def test_agreement_with_plain_slice_gate_on_clear_cases(self):
        # far from any threshold the ci and p-value formulations agree
        clear = self.total_single_slice_regression()
        clean = self.no_change()
        assert gate_slice(clear).passed == gate_slice_bonferroni(clear).passed
        assert gate_slice(clean).passed == gate_slice_bonferroni(clean).passed

    def test_slices_carry_p_ge_zero(self):
        comparison = self.no_change()
        for cat in comparison.categories:
            p_le = cat.comparison.p_le_zero
            p_ge = cat.comparison.p_ge_zero
            assert 0.0 <= p_ge <= 1.0
            assert p_le + p_ge >= 1.0
