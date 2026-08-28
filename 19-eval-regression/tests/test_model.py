import pytest

from eval_harness.data import CATEGORIES
from eval_harness.model import (
    BASELINE,
    DRIFT,
    IMPROVED,
    MASKED_REGRESSION,
    P_MAX,
    P_MIN,
    ScriptedModel,
    VERSIONS,
    stable_u64,
)
from tests.test_data import make_item

FULL_SKILLS = {c: 0.8 for c in CATEGORIES}


class TestStableSeed:
    def test_deterministic(self):
        assert stable_u64("a", "b") == stable_u64("a", "b")

    def test_distinct_parts_distinct_seeds(self):
        assert stable_u64("a", "b") != stable_u64("a", "c")

    def test_fits_64_bits(self):
        assert 0 <= stable_u64("x") < 2**64


class TestScriptedModel:
    def test_missing_category_rejected(self):
        skills = {c: 0.8 for c in CATEGORIES if c != "unit"}
        with pytest.raises(ValueError, match="missing skills"):
            ScriptedModel(name="broken", skills=skills)

    def test_out_of_range_skill_rejected(self):
        with pytest.raises(ValueError, match="out of"):
            ScriptedModel(name="broken", skills={**FULL_SKILLS, "unit": 1.4})

    def test_p_correct_adds_difficulty(self):
        model = ScriptedModel(name="m", skills=FULL_SKILLS)
        assert model.p_correct(make_item(difficulty=0.05)) == pytest.approx(0.85)

    def test_p_correct_clamps_both_ends(self):
        low = ScriptedModel(name="low", skills={**FULL_SKILLS, "unit": 0.0})
        high = ScriptedModel(name="high", skills={**FULL_SKILLS, "unit": 1.0})
        assert low.p_correct(make_item(difficulty=-0.4)) == P_MIN
        assert high.p_correct(make_item(difficulty=0.4)) == P_MAX

    def test_answer_deterministic_per_seed(self):
        item = make_item()
        assert BASELINE.answer(item, 7) == BASELINE.answer(item, 7)

    def test_answer_is_expected_or_distractor(self):
        item = make_item()
        for seed in range(200):
            assert BASELINE.answer(item, seed) in (item.expected, item.distractor)

    def test_answers_vary_across_seeds(self):
        item = make_item(difficulty=0.0)
        answers = {BASELINE.answer(item, seed) for seed in range(200)}
        assert answers == {item.expected, item.distractor}

    def test_observed_rate_tracks_p_correct(self):
        item = make_item(difficulty=0.0)
        model = ScriptedModel(name="m", skills={**FULL_SKILLS, "unit": 0.9})
        hits = sum(
            1 for seed in range(2000) if model.answer(item, seed) == item.expected
        )
        assert 0.87 < hits / 2000 < 0.93

    def test_certain_model_always_correct(self):
        model = ScriptedModel(name="sure", skills={c: 1.0 for c in CATEGORIES})
        item = make_item(difficulty=0.4)
        # p clamps at P_MAX, not 1.0, so allow the rare miss but demand near-all
        hits = sum(
            1 for seed in range(500) if model.answer(item, seed) == item.expected
        )
        assert hits >= 490


class TestVersions:
    def test_registry_names_match(self):
        for name, model in VERSIONS.items():
            assert model.name == name

    def test_masked_regression_mean_skill_matches_baseline(self):
        base_mean = sum(BASELINE.skills.values()) / len(BASELINE.skills)
        masked_mean = sum(MASKED_REGRESSION.skills.values()) / len(
            MASKED_REGRESSION.skills
        )
        assert masked_mean == pytest.approx(base_mean)

    def test_masked_regression_drops_date(self):
        assert MASKED_REGRESSION.skills["date"] == pytest.approx(
            BASELINE.skills["date"] - 0.24
        )

    def test_drift_drops_every_category(self):
        for category in CATEGORIES:
            assert DRIFT.skills[category] == pytest.approx(
                BASELINE.skills[category] - 0.03
            )

    def test_improved_raises_every_category(self):
        for category in CATEGORIES:
            assert IMPROVED.skills[category] > BASELINE.skills[category]
