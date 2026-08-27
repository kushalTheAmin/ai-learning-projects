import random

import pytest

from neardup.mutations import (
    MUTATIONS,
    case_and_whitespace_noise,
    drop_words,
    shuffle_sentences,
    truncate,
    with_typos,
)
from neardup.shingles import word_shingles

SAMPLE = (
    "A read-through cache sits between the application and the database. "
    "On a miss the cache loads the value from the backing store. "
    "The pattern keeps cache population logic in one place. "
    "A cold cache still sends every first read downstream."
)


@pytest.mark.parametrize("name,fn", list(MUTATIONS.items()))
class TestAllMutations:
    def test_deterministic_given_seed(self, name, fn):
        out1 = fn(SAMPLE, random.Random(f"seed:{name}"))
        out2 = fn(SAMPLE, random.Random(f"seed:{name}"))
        assert out1 == out2

    def test_changes_raw_text(self, name, fn):
        assert fn(SAMPLE, random.Random(f"seed:{name}")) != SAMPLE

    def test_output_nonempty(self, name, fn):
        assert fn(SAMPLE, random.Random(f"seed:{name}")).strip()

    def test_unicode_survives(self, name, fn):
        text = (
            "Café touché naïve. 日本語のテキストです. Emoji 🎉 works fine. "
            "More words here so every mutation has something to chew on."
        )
        out = fn(text, random.Random(f"seed:{name}"))
        assert isinstance(out, str) and out


class TestTypos:
    def test_edit_budget_bounds_length(self):
        out = with_typos(SAMPLE, random.Random(1))
        edits = max(3, len(SAMPLE) // 50)
        assert len(SAMPLE) - edits <= len(out) <= len(SAMPLE) + edits


class TestDropWords:
    def test_drops_expected_count(self):
        out = drop_words(SAMPLE, random.Random(1))
        expected_drop = max(1, len(SAMPLE.split()) // 10)
        assert len(out.split()) == len(SAMPLE.split()) - expected_drop

    def test_single_word_unchanged(self):
        assert drop_words("word", random.Random(1)) == "word"


class TestShuffleSentences:
    def test_same_sentences_new_order(self):
        out = shuffle_sentences(SAMPLE, random.Random(1))
        assert out != SAMPLE
        assert sorted(out.replace(". ", ".|").split("|")) == sorted(
            SAMPLE.replace(". ", ".|").split("|")
        )

    def test_single_sentence_unchanged(self):
        text = "Just one sentence here"
        assert shuffle_sentences(text, random.Random(1)) == text


class TestTruncate:
    def test_keeps_70_percent_prefix(self):
        out = truncate(SAMPLE, random.Random(1))
        words = SAMPLE.split()
        assert out.split() == words[: (len(words) * 7) // 10]

    def test_single_word(self):
        assert truncate("word", random.Random(1)) == "word"


class TestNoise:
    def test_invisible_after_normalization(self):
        out = case_and_whitespace_noise(SAMPLE, random.Random(1))
        assert out != SAMPLE
        assert word_shingles(out) == word_shingles(SAMPLE)
