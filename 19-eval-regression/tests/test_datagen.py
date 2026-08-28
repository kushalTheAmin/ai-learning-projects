from pathlib import Path

import pytest

from eval_harness.data import CATEGORIES, load_golden, normalize
from eval_harness.datagen import build_golden_items

GOLDEN_PATH = Path(__file__).resolve().parents[1] / "data" / "golden.jsonl"


class TestBuilder:
    def test_default_build_shape(self):
        items = build_golden_items()
        assert len(items) == 240
        for category in CATEGORIES:
            assert sum(1 for i in items if i.category == category) == 40

    def test_deterministic(self):
        assert build_golden_items() == build_golden_items()

    def test_seed_changes_items(self):
        assert build_golden_items(seed=1) != build_golden_items(seed=2)

    def test_distractor_never_matches_expected(self):
        for item in build_golden_items(per_category=120, seed=3):
            assert normalize(item.distractor) != normalize(item.expected)

    def test_scales_to_power_curve_sizes(self):
        items = build_golden_items(per_category=640, seed=10840)
        assert len(items) == 3840
        assert len({i.input_text for i in items}) == 3840

    def test_rejects_zero_per_category(self):
        with pytest.raises(ValueError, match="per_category"):
            build_golden_items(per_category=0)

    def test_single_item_per_category(self):
        items = build_golden_items(per_category=1, seed=4)
        assert len(items) == len(CATEGORIES)


class TestGroundTruthAnswers:
    def test_date_answers_are_true_weekdays(self):
        import datetime

        for item in build_golden_items(per_category=30, seed=5):
            if item.category != "date":
                continue
            iso = item.input_text.split("was ")[1].rstrip("?")
            weekday = datetime.date.fromisoformat(iso).strftime("%A").lower()
            assert item.expected == weekday

    def test_arithmetic_answers_evaluate(self):
        for item in build_golden_items(per_category=30, seed=6):
            if item.category != "arithmetic":
                continue
            expression = item.input_text.split("compute ")[1].split(".")[0]
            assert str(eval(expression)) == item.expected

    def test_unit_answers_use_true_factor(self):
        factors = {"minutes": 60, "hours": 60, "kilobytes": 1024}
        for item in build_golden_items(per_category=30, seed=7):
            if item.category != "unit":
                continue
            words = item.input_text.split()
            amount, source = int(words[1]), words[2]
            assert item.expected == str(amount * factors[source])


class TestCommittedDataset:
    def test_committed_file_matches_builder_exactly(self):
        assert load_golden(GOLDEN_PATH) == build_golden_items()
