import json

import pytest

from eval_harness.data import CATEGORIES, GoldenItem
from eval_harness.harness import load_run, run_eval, save_run
from eval_harness.model import BASELINE, ScriptedModel
from tests.test_data import make_item


def two_category_items() -> list[GoldenItem]:
    return [
        make_item(item_id="unit-0000"),
        make_item(
            item_id="unit-0001",
            input_text="convert 3 minutes to seconds. answer with the number only.",
            expected="180",
            distractor="300",
        ),
        make_item(
            item_id="date-0000",
            category="date",
            input_text="what day of the week was 2024-03-15?",
            expected="friday",
            distractor="saturday",
        ),
    ]


class TestRunEval:
    def test_empty_items_rejected(self):
        with pytest.raises(ValueError, match="zero items"):
            run_eval(BASELINE, [], eval_seed=1)

    def test_deterministic_per_seed(self):
        items = two_category_items()
        assert run_eval(BASELINE, items, 3) == run_eval(BASELINE, items, 3)

    def test_accuracy_matches_outcomes(self):
        record = run_eval(BASELINE, two_category_items(), 5)
        correct = sum(1 for o in record.outcomes if o.correct)
        assert record.accuracy == correct / len(record.outcomes)

    def test_category_accuracy_partitions_items(self):
        record = run_eval(BASELINE, two_category_items(), 5)
        assert set(record.category_accuracy) == {"unit", "date"}
        unit_flags = [o.correct for o in record.outcomes if o.category == "unit"]
        assert record.category_accuracy["unit"] == sum(unit_flags) / len(unit_flags)

    def test_perfect_model_scores_every_item(self):
        sure = ScriptedModel(name="sure", skills={c: 1.0 for c in CATEGORIES})
        items = [
            make_item(item_id=f"unit-{i:04d}", input_text=f"q{i}", difficulty=0.0)
            for i in range(20)
        ]
        record = run_eval(sure, items, 1)
        assert record.accuracy == 1.0

    def test_hopeless_model_scores_zero(self):
        lost = ScriptedModel(name="lost", skills={c: 0.0 for c in CATEGORIES})
        items = [
            make_item(item_id=f"unit-{i:04d}", input_text=f"q{i}", difficulty=0.0)
            for i in range(20)
        ]
        # skills clamp at P_MIN, so an occasional hit is possible; pin the
        # answers instead of assuming exactly zero
        record = run_eval(lost, items, 1)
        for outcome in record.outcomes:
            assert outcome.correct == (outcome.answer == "120")

    def test_single_item_run(self):
        record = run_eval(BASELINE, [make_item()], 9)
        assert record.accuracy in (0.0, 1.0)
        assert len(record.outcomes) == 1


class TestPersistence:
    def test_round_trip(self, tmp_path):
        record = run_eval(BASELINE, two_category_items(), 5)
        path = tmp_path / "run.json"
        save_run(record, path)
        assert load_run(path) == record

    def test_wrong_schema_version_rejected(self, tmp_path):
        record = run_eval(BASELINE, two_category_items(), 5)
        path = tmp_path / "run.json"
        save_run(record, path)
        payload = json.loads(path.read_text())
        payload["schema_version"] = 99
        path.write_text(json.dumps(payload))
        with pytest.raises(ValueError, match="schema_version"):
            load_run(path)

    def test_tampered_accuracy_rejected(self, tmp_path):
        record = run_eval(BASELINE, two_category_items(), 5)
        path = tmp_path / "run.json"
        save_run(record, path)
        payload = json.loads(path.read_text())
        payload["accuracy"] = 0.123
        path.write_text(json.dumps(payload))
        with pytest.raises(ValueError, match="recompute"):
            load_run(path)

    def test_truncated_outcomes_rejected(self, tmp_path):
        record = run_eval(BASELINE, two_category_items(), 5)
        path = tmp_path / "run.json"
        save_run(record, path)
        payload = json.loads(path.read_text())
        payload["outcomes"] = payload["outcomes"][:-1]
        path.write_text(json.dumps(payload))
        with pytest.raises(ValueError):
            load_run(path)

    def test_not_json_rejected(self, tmp_path):
        path = tmp_path / "run.json"
        path.write_text("not json at all")
        with pytest.raises(ValueError, match="not valid json"):
            load_run(path)

    def test_missing_field_rejected(self, tmp_path):
        record = run_eval(BASELINE, two_category_items(), 5)
        path = tmp_path / "run.json"
        save_run(record, path)
        payload = json.loads(path.read_text())
        del payload["fingerprint"]
        path.write_text(json.dumps(payload))
        with pytest.raises(ValueError, match="wrong fields"):
            load_run(path)
