import dataclasses

import pytest

from eval_harness.compare import (
    compare_runs,
    gate_ci,
    gate_combined,
    gate_naive,
    gate_slice,
)
from eval_harness.data import CATEGORIES
from eval_harness.harness import run_eval
from eval_harness.model import BASELINE, ScriptedModel
from tests.test_data import make_item

RESAMPLES = 400


def items_for(categories: tuple[str, ...], per_category: int):
    items = []
    for category in categories:
        for i in range(per_category):
            items.append(
                make_item(
                    item_id=f"{category}-{i:04d}",
                    category=category,
                    input_text=f"{category} question {i}",
                    difficulty=0.0,
                )
            )
    return items


SURE = ScriptedModel(name="sure", skills={c: 1.0 for c in CATEGORIES})
LOST = ScriptedModel(name="lost", skills={c: 0.0 for c in CATEGORIES})


class TestCompareRuns:
    def test_run_against_itself_is_all_zero(self):
        items = items_for(("unit", "date"), 10)
        record = run_eval(BASELINE, items, 1)
        comparison = compare_runs(record, record, n_resamples=RESAMPLES)
        assert comparison.aggregate.diff == 0.0
        assert comparison.aggregate.ci.lo == 0.0
        assert comparison.aggregate.ci.hi == 0.0
        assert comparison.flips.fixed == 0
        assert comparison.flips.broken == 0

    def test_flip_table_sums_to_n(self):
        items = items_for(("unit", "date"), 15)
        comparison = compare_runs(
            run_eval(BASELINE, items, 1),
            run_eval(BASELINE, items, 2),
            n_resamples=RESAMPLES,
        )
        flips = comparison.flips
        total = flips.both_correct + flips.both_wrong + flips.fixed + flips.broken
        assert total == comparison.n_items == 30

    def test_flip_counts_match_hand_walk(self):
        items = items_for(("unit",), 12)
        base = run_eval(BASELINE, items, 1)
        cand = run_eval(BASELINE, items, 2)
        comparison = compare_runs(base, cand, n_resamples=RESAMPLES)
        fixed = sum(
            1
            for b, c in zip(base.outcomes, cand.outcomes)
            if not b.correct and c.correct
        )
        broken = sum(
            1
            for b, c in zip(base.outcomes, cand.outcomes)
            if b.correct and not c.correct
        )
        assert comparison.flips.fixed == fixed
        assert comparison.flips.broken == broken

    def test_delta_is_candidate_minus_baseline(self):
        items = items_for(("unit",), 10)
        comparison = compare_runs(
            run_eval(LOST, items, 1),
            run_eval(SURE, items, 2),
            n_resamples=RESAMPLES,
        )
        assert comparison.aggregate.diff == pytest.approx(
            comparison.candidate_accuracy - comparison.baseline_accuracy
        )
        assert comparison.aggregate.diff >= 0.9

    def test_per_category_deltas_isolate_categories(self):
        items = items_for(("unit", "date"), 10)
        base = run_eval(SURE, items, 1)
        cand_record = run_eval(SURE, items, 2)
        # break only the date items in the candidate by hand
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
        comparison = compare_runs(base, cand, n_resamples=RESAMPLES)
        by_name = {c.category: c for c in comparison.categories}
        assert by_name["date"].comparison.diff == -1.0
        assert by_name["unit"].comparison.diff == 0.0

    def test_different_fingerprints_rejected(self):
        items_a = items_for(("unit",), 10)
        items_b = items_for(("date",), 10)
        with pytest.raises(ValueError, match="different datasets"):
            compare_runs(
                run_eval(BASELINE, items_a, 1),
                run_eval(BASELINE, items_b, 1),
                n_resamples=RESAMPLES,
            )

    def test_deterministic(self):
        items = items_for(("unit", "date"), 10)
        base = run_eval(BASELINE, items, 1)
        cand = run_eval(BASELINE, items, 2)
        first = compare_runs(base, cand, n_resamples=RESAMPLES, seed=5)
        second = compare_runs(base, cand, n_resamples=RESAMPLES, seed=5)
        assert first == second

    def test_single_item_runs_compare(self):
        items = [make_item(difficulty=0.0)]
        comparison = compare_runs(
            run_eval(SURE, items, 1),
            run_eval(SURE, items, 2),
            n_resamples=RESAMPLES,
        )
        assert comparison.n_items == 1


class TestGates:
    def big_regression(self):
        items = items_for(("unit", "date"), 20)
        return compare_runs(
            run_eval(SURE, items, 1),
            run_eval(LOST, items, 2),
            n_resamples=RESAMPLES,
        )

    def no_change(self):
        items = items_for(("unit", "date"), 20)
        record = run_eval(BASELINE, items, 1)
        return compare_runs(record, record, n_resamples=RESAMPLES)

    def test_naive_gate_fails_on_big_drop(self):
        assert not gate_naive(self.big_regression(), 0.02).passed

    def test_naive_gate_passes_no_change(self):
        assert gate_naive(self.no_change(), 0.02).passed

    def test_naive_gate_threshold_is_a_boundary(self):
        comparison = self.big_regression()
        drop = -comparison.aggregate.diff
        assert not gate_naive(comparison, drop - 0.01).passed
        assert gate_naive(comparison, drop + 0.01).passed

    def test_naive_gate_rejects_negative_threshold(self):
        with pytest.raises(ValueError, match="max_drop"):
            gate_naive(self.no_change(), -0.1)

    def test_ci_gate_fails_on_big_drop(self):
        verdict = gate_ci(self.big_regression())
        assert not verdict.passed

    def test_ci_gate_passes_no_change(self):
        assert gate_ci(self.no_change()).passed

    def test_slice_gate_fails_and_names_the_slice(self):
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
        verdict = gate_slice(compare_runs(base, cand, n_resamples=RESAMPLES))
        assert not verdict.passed
        assert "date" in verdict.reason
        assert "unit" not in verdict.reason

    def test_slice_gate_passes_no_change(self):
        assert gate_slice(self.no_change()).passed

    def test_combined_gate_fails_when_either_fails(self):
        assert not gate_combined(self.big_regression()).passed
        assert gate_combined(self.no_change()).passed
