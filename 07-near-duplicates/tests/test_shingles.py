import pytest

from neardup.shingles import (
    hash_shingle,
    hashed_shingles,
    jaccard,
    normalize,
    tokenize,
    word_shingles,
)


class TestNormalize:
    def test_casefolds(self):
        assert normalize("The CACHE") == "the cache"

    def test_collapses_whitespace(self):
        assert normalize("a  b\t c\n\nd") == "a b c d"

    def test_nfkc_folds_fullwidth(self):
        assert normalize("Ｃafe") == "cafe"

    def test_empty(self):
        assert normalize("") == ""
        assert normalize("   \n\t ") == ""


class TestTokenize:
    def test_strips_punctuation(self):
        assert tokenize("hello, world! (yes)") == ["hello", "world", "yes"]

    def test_underscore_splits(self):
        assert tokenize("snake_case_name") == ["snake", "case", "name"]

    def test_cjk_run_is_one_token(self):
        # Known limitation, pinned: scripts without spaces tokenize as
        # whole runs, so shingling is only meaningful for spaced scripts.
        assert tokenize("日本語") == ["日本語"]


class TestWordShingles:
    def test_empty_text(self):
        assert word_shingles("") == set()

    def test_punctuation_only(self):
        assert word_shingles("... !!! ???") == set()

    def test_shorter_than_n_yields_single_shingle(self):
        assert word_shingles("hello world", n=3) == {"hello world"}
        assert word_shingles("hello", n=3) == {"hello"}

    def test_exactly_n(self):
        assert word_shingles("a b c", n=3) == {"a b c"}

    def test_count_and_content(self):
        got = word_shingles("one two three four", n=3)
        assert got == {"one two three", "two three four"}

    def test_repeated_text_collapses(self):
        assert word_shingles("a b a b a b", n=3) == {"a b a", "b a b"}

    def test_case_and_spacing_invariant(self):
        assert word_shingles("The  Quick FOX ran") == word_shingles(
            "the quick fox ran"
        )

    def test_invalid_n(self):
        with pytest.raises(ValueError):
            word_shingles("a b c", n=0)


class TestHashing:
    def test_hash_is_64_bit(self):
        h = hash_shingle("the quick fox")
        assert 0 <= h < 1 << 64

    def test_hash_stable_across_calls(self):
        assert hash_shingle("a b c") == hash_shingle("a b c")

    def test_pinned_value(self):
        # blake2b is specified, so this value is stable across machines;
        # a change here means every committed measurement shifts.
        assert hash_shingle("the quick fox") == 4782980024393698047

    def test_hashed_shingles_matches_string_shingles(self):
        text = "one two three four five"
        assert hashed_shingles(text) == {
            hash_shingle(s) for s in word_shingles(text)
        }


class TestJaccard:
    def test_identical(self):
        assert jaccard({1, 2, 3}, {1, 2, 3}) == 1.0

    def test_disjoint(self):
        assert jaccard({1, 2}, {3, 4}) == 0.0

    def test_both_empty(self):
        assert jaccard(set(), set()) == 1.0

    def test_one_empty(self):
        assert jaccard(set(), {1}) == 0.0

    def test_partial_overlap(self):
        assert jaccard({1, 2, 3}, {2, 3, 4}) == pytest.approx(2 / 4)
