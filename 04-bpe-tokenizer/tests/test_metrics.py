import pytest

from metrics import bytes_per_token, cost_usd, tokens_per_char, utf8_bytes


class TestUtf8Bytes:
    def test_ascii_is_one_byte_per_char(self):
        assert utf8_bytes("hello") == 5

    def test_accented_latin_is_two_bytes(self):
        assert utf8_bytes("héllo") == 6

    def test_cjk_is_three_bytes(self):
        assert utf8_bytes("日") == 3

    def test_emoji_is_four_bytes(self):
        assert utf8_bytes("🚀") == 4

    def test_empty(self):
        assert utf8_bytes("") == 0


class TestRatios:
    def test_bytes_per_token(self):
        assert bytes_per_token("hello world", 4) == pytest.approx(11 / 4)

    def test_bytes_per_token_zero_tokens(self):
        assert bytes_per_token("", 0) == 0.0

    def test_tokens_per_char(self):
        assert tokens_per_char("日本語", 6) == pytest.approx(2.0)

    def test_tokens_per_char_empty_text(self):
        assert tokens_per_char("", 0) == 0.0


class TestCost:
    def test_one_million_tokens_costs_the_rate(self):
        assert cost_usd(1_000_000, 3.0) == pytest.approx(3.0)

    def test_scales_linearly(self):
        assert cost_usd(500_000, 3.0) == pytest.approx(1.5)
        assert cost_usd(0, 3.0) == 0.0

    def test_negative_inputs_rejected(self):
        with pytest.raises(ValueError):
            cost_usd(-1, 3.0)
        with pytest.raises(ValueError):
            cost_usd(100, -0.5)
