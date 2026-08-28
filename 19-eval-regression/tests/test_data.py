import pytest

from eval_harness.data import (
    GoldenItem,
    dataset_fingerprint,
    load_golden,
    normalize,
    save_golden,
    validate_items,
)


def make_item(**overrides) -> GoldenItem:
    fields = dict(
        item_id="unit-0000",
        category="unit",
        input_text="convert 2 minutes to seconds. answer with the number only.",
        expected="120",
        distractor="200",
        difficulty=0.01,
    )
    fields.update(overrides)
    return GoldenItem(**fields)


class TestNormalize:
    def test_casefolds_trims_and_collapses_whitespace(self):
        assert normalize("  Foo   BAR \n baz ") == "foo bar baz"

    def test_unicode_casefold(self):
        assert normalize("Straße") == normalize("strasse")

    def test_empty_string(self):
        assert normalize("   ") == ""


class TestValidation:
    def test_valid_items_pass(self):
        validate_items([make_item()])

    def test_empty_dataset_rejected(self):
        with pytest.raises(ValueError, match="non-empty"):
            validate_items([])

    def test_duplicate_ids_rejected(self):
        second = make_item(input_text="convert 3 minutes to seconds.")
        with pytest.raises(ValueError, match="duplicate item id"):
            validate_items([make_item(), second])

    def test_duplicate_inputs_rejected(self):
        second = make_item(item_id="unit-0001")
        with pytest.raises(ValueError, match="duplicate input"):
            validate_items([make_item(), second])

    def test_unknown_category_rejected(self):
        with pytest.raises(ValueError, match="unknown category"):
            validate_items([make_item(category="trivia")])

    def test_distractor_equal_to_expected_rejected(self):
        with pytest.raises(ValueError, match="normalizes equal"):
            validate_items([make_item(distractor=" 120 ")])

    def test_out_of_range_difficulty_rejected(self):
        with pytest.raises(ValueError, match="difficulty"):
            validate_items([make_item(difficulty=0.9)])


class TestFingerprint:
    def test_stable_for_identical_items(self):
        assert dataset_fingerprint([make_item()]) == dataset_fingerprint(
            [make_item()]
        )

    def test_changes_when_any_field_changes(self):
        assert dataset_fingerprint([make_item()]) != dataset_fingerprint(
            [make_item(expected="121", distractor="200")]
        )

    def test_order_sensitive(self):
        a = make_item()
        b = make_item(item_id="unit-0001", input_text="convert 3 minutes to seconds.")
        assert dataset_fingerprint([a, b]) != dataset_fingerprint([b, a])


class TestRoundTrip:
    def test_save_and_load_preserve_items(self, tmp_path):
        items = [
            make_item(),
            make_item(
                item_id="entity-0000",
                category="entity",
                input_text="which service failed, naïve-café or auth-gateway?",
                expected="naïve-café",
                distractor="auth-gateway",
            ),
        ]
        path = tmp_path / "golden.jsonl"
        save_golden(items, path)
        assert load_golden(path) == items

    def test_empty_file_rejected(self, tmp_path):
        path = tmp_path / "golden.jsonl"
        path.write_text("", encoding="utf-8")
        with pytest.raises(ValueError, match="non-empty"):
            load_golden(path)

    def test_malformed_json_rejected(self, tmp_path):
        path = tmp_path / "golden.jsonl"
        path.write_text('{"item_id": "x"\n', encoding="utf-8")
        with pytest.raises(ValueError, match="not valid json"):
            load_golden(path)

    def test_wrong_fields_rejected(self, tmp_path):
        path = tmp_path / "golden.jsonl"
        path.write_text('{"item_id": "x", "unexpected": 1}\n', encoding="utf-8")
        with pytest.raises(ValueError, match="wrong fields"):
            load_golden(path)
