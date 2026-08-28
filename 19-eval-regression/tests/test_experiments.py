import pytest

from eval_harness.data import CATEGORIES
from eval_harness.experiments import (
    GATE_NAMES,
    measure_gate_rates,
    power_curve,
)
from eval_harness.model import BASELINE, ScriptedModel
from tests.test_compare import items_for

SURE = ScriptedModel(name="sure", skills={c: 1.0 for c in CATEGORIES})
LOST = ScriptedModel(name="lost", skills={c: 0.0 for c in CATEGORIES})


class TestGateRates:
    def test_rates_are_fractions(self):
        items = items_for(("unit", "date"), 8)
        rates = measure_gate_rates(items, BASELINE, BASELINE, 4, 50, "t1")
        assert set(rates.fail_rates) == set(GATE_NAMES)
        for rate in rates.fail_rates.values():
            assert 0.0 <= rate <= 1.0
        assert 0.0 <= rates.improve_rate <= 1.0

    def test_catastrophic_regression_always_detected(self):
        items = items_for(("unit", "date"), 15)
        rates = measure_gate_rates(items, SURE, LOST, 4, 50, "t2")
        assert rates.fail_rates["ci"] == 1.0
        assert rates.fail_rates["slice"] == 1.0
        assert rates.fail_rates["ci+slice"] == 1.0
        assert rates.mean_delta < -0.9

    def test_identical_model_mean_delta_near_zero(self):
        items = items_for(("unit", "date"), 15)
        rates = measure_gate_rates(items, BASELINE, BASELINE, 6, 50, "t3")
        assert -0.15 < rates.mean_delta < 0.15
        assert rates.min_delta <= rates.mean_delta <= rates.max_delta

    def test_deterministic(self):
        items = items_for(("unit",), 10)
        first = measure_gate_rates(items, BASELINE, BASELINE, 3, 50, "t4")
        second = measure_gate_rates(items, BASELINE, BASELINE, 3, 50, "t4")
        assert first == second

    def test_label_changes_seed_stream(self):
        items = items_for(("unit",), 10)
        first = measure_gate_rates(items, BASELINE, BASELINE, 3, 50, "t5")
        second = measure_gate_rates(items, BASELINE, BASELINE, 3, 50, "t6")
        assert first.mean_delta != second.mean_delta

    def test_rejects_zero_pairs(self):
        items = items_for(("unit",), 5)
        with pytest.raises(ValueError, match="n_pairs"):
            measure_gate_rates(items, BASELINE, BASELINE, 0, 50, "t7")


class TestPowerCurve:
    def test_catastrophic_regression_detected_at_any_size(self):
        points = power_curve(SURE, LOST, (12,), 3, 50, datagen_seed=100)
        assert points[0].n_items == 12
        assert points[0].detection_rate == 1.0

    def test_sizes_must_split_into_categories(self):
        with pytest.raises(ValueError, match="divisible"):
            power_curve(SURE, LOST, (10,), 2, 50, datagen_seed=100)

    def test_no_change_rarely_detected(self):
        points = power_curve(BASELINE, BASELINE, (24,), 4, 50, datagen_seed=101)
        assert points[0].detection_rate <= 0.25

    def test_deterministic(self):
        first = power_curve(SURE, LOST, (12,), 2, 50, datagen_seed=102)
        second = power_curve(SURE, LOST, (12,), 2, 50, datagen_seed=102)
        assert first == second
