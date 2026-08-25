import json

import pytest

from extractor.parsing import (
    ParseError,
    extract_balanced_object,
    parse_lenient,
    parse_python_literal,
    parse_strict,
    remove_trailing_commas,
    strip_code_fence,
)


class TestParseStrict:
    def test_valid_object(self):
        assert parse_strict('{"a": 1}') == {"a": 1}

    def test_rejects_array(self):
        with pytest.raises(ParseError, match="expected a JSON object"):
            parse_strict('[{"a": 1}]')

    def test_rejects_scalar(self):
        with pytest.raises(ParseError, match="expected a JSON object"):
            parse_strict("42")

    def test_rejects_invalid_json(self):
        with pytest.raises(ParseError, match="not valid JSON"):
            parse_strict("{nope}")

    def test_duplicate_keys_last_wins(self):
        # json.loads keeps the last occurrence; pin that behavior down
        assert parse_strict('{"a": 1, "a": 2}') == {"a": 2}


class TestStripCodeFence:
    def test_json_fence(self):
        assert strip_code_fence('```json\n{"a": 1}\n```') == '{"a": 1}'

    def test_bare_fence(self):
        assert strip_code_fence('```\n{"a": 1}\n```') == '{"a": 1}'

    def test_no_fence_passthrough(self):
        assert strip_code_fence('{"a": 1}') == '{"a": 1}'


class TestExtractBalancedObject:
    def test_object_inside_prose(self):
        text = 'Here you go: {"a": 1} hope that helps!'
        assert extract_balanced_object(text) == '{"a": 1}'

    def test_nested_objects(self):
        text = 'x {"a": {"b": {"c": 1}}} y'
        assert extract_balanced_object(text) == '{"a": {"b": {"c": 1}}}'

    def test_braces_inside_strings_ignored(self):
        text = '{"code": "if (x) { return; }"}'
        assert extract_balanced_object(text) == text

    def test_escaped_quotes_inside_strings(self):
        text = '{"msg": "she said \\"hi {there}\\""}'
        assert extract_balanced_object(text) == text
        assert json.loads(extract_balanced_object(text))["msg"] == 'she said "hi {there}"'

    def test_no_object(self):
        assert extract_balanced_object("no json here") is None

    def test_single_quoted_value_with_closing_brace(self):
        # python-dict output is a failure mode this project handles, so the
        # walker has to respect ' as a string delimiter too - otherwise the
        # } inside the value ends the object early
        text = "{'summary': 'missing } brace', 'areas': ['api']}"
        assert extract_balanced_object(text) == text

    def test_single_quoted_value_with_opening_brace(self):
        text = "{'summary': 'stray { brace', 'areas': ['api']}"
        assert extract_balanced_object(text) == text

    def test_apostrophe_inside_double_quoted_string_is_not_a_delimiter(self):
        text = '{"summary": "it\'s fine {here}", "areas": ["api"]}'
        assert extract_balanced_object(text) == text

    def test_unclosed_object(self):
        assert extract_balanced_object('{"a": 1') is None

    def test_prose_with_stray_braces_before_object(self):
        text = 'use {placeholders} like this: {"a": 1}'
        # first { opens at the stray brace; the walker treats it as depth-1
        # and closes at }, yielding the stray pair - callers fall through to
        # other layers when that fragment fails to parse
        assert extract_balanced_object(text) == "{placeholders}"


class TestRemoveTrailingCommas:
    def test_object_trailing_comma(self):
        assert json.loads(remove_trailing_commas('{"a": 1,}')) == {"a": 1}

    def test_array_trailing_comma(self):
        assert json.loads(remove_trailing_commas('{"a": [1, 2,],}')) == {"a": [1, 2]}

    def test_comma_with_whitespace(self):
        assert json.loads(remove_trailing_commas('{"a": 1 , \n }')) == {"a": 1}

    def test_commas_inside_strings_untouched(self):
        text = '{"a": "1,}"}'
        assert remove_trailing_commas(text) == text

    def test_valid_json_unchanged(self):
        text = '{"a": [1, 2], "b": {"c": 3}}'
        assert remove_trailing_commas(text) == text


class TestParsePythonLiteral:
    def test_single_quoted_dict(self):
        assert parse_python_literal("{'a': 'b'}") == {"a": "b"}

    def test_apostrophe_in_value(self):
        assert parse_python_literal('{"a": "it\'s fine"}') == {"a": "it's fine"}

    def test_rejects_non_dict(self):
        with pytest.raises(ParseError, match="expected a dict"):
            parse_python_literal("[1, 2]")

    def test_rejects_code(self):
        with pytest.raises(ParseError):
            parse_python_literal("__import__('os').system('true')")


class TestParseLenient:
    def test_layer_reporting(self):
        cases = [
            ('{"a": 1}', "strict"),
            ('```json\n{"a": 1}\n```', "fence"),
            ('Sure! {"a": 1} Done.', "extract"),
            ('{"a": 1,}', "repair_commas"),
            ("{'a': 1}", "python_literal"),
        ]
        for text, expected_layer in cases:
            obj, layer = parse_lenient(text)
            assert obj == {"a": 1}
            assert layer == expected_layer

    def test_python_dict_with_brace_in_a_value(self):
        text = "{'summary': 'use the {x} placeholder', 'areas': ['api']}"
        obj, layer = parse_lenient(text)
        assert obj == {"summary": "use the {x} placeholder", "areas": ["api"]}
        assert layer == "python_literal"

    def test_python_dict_with_unmatched_brace_in_a_value(self):
        text = "{'summary': 'missing } brace', 'areas': ['api']}"
        obj, layer = parse_lenient(text)
        assert obj == {"summary": "missing } brace", "areas": ["api"]}
        assert layer == "python_literal"

    def test_empty_string(self):
        with pytest.raises(ParseError, match="empty response"):
            parse_lenient("")

    def test_whitespace_only(self):
        with pytest.raises(ParseError, match="empty response"):
            parse_lenient("   \n\t ")

    def test_prose_without_json(self):
        with pytest.raises(ParseError, match="no parseable JSON object"):
            parse_lenient("I'm sorry, I can't extract that information.")

    def test_truncated_json(self):
        with pytest.raises(ParseError):
            parse_lenient('{"a": "unterminated')

    def test_unicode_content(self):
        obj, layer = parse_lenient('{"summary": "請求書 🙏 naïve"}')
        assert obj["summary"] == "請求書 🙏 naïve"
        assert layer == "strict"

    def test_fenced_object_with_prose_around_fence(self):
        obj, layer = parse_lenient('Here it is:\n```json\n{"a": 1}\n```\nEnjoy!')
        assert obj == {"a": 1}
        assert layer == "fence"

    def test_oversized_junk_input(self):
        # 1MB of non-JSON must fail cleanly and quickly, not hang or blow up
        with pytest.raises(ParseError):
            parse_lenient("x" * 1_000_000)

    def test_oversized_valid_input(self):
        big = json.dumps({"k": "v" * 500_000})
        obj, layer = parse_lenient(big)
        assert layer == "strict"
        assert len(obj["k"]) == 500_000
