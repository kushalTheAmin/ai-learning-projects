"""The word baseline's OOV rate is published over a padded denominator.

`word_split` is `\\S+|\\s+`, so it emits a whitespace run between every pair
of words. `oov_stats` counts those runs in its denominator, and on the
committed corpus not one of them is ever unknown — a handful of whitespace
runs are the most frequent types in any training text, so they are always
bought first and can never miss. Words and whitespace runs alternate, so the
two counts are equal to the token and the padding divides the published rate
by exactly two: heldout prose reads 209/1032 = 20.3% when 209 of its 516
words are gone, which is 40.5%. Heldout unicode is the one that changes
character — 45.4% reads as "about half the stream" where the real figure is
90.8%, meaning essentially every word in the file is destroyed.

The rate that answers "what does a closed word vocabulary lose" is the one
over words. So `oov_stats` has to leave the whitespace runs out of both
terms, and the run and the readme have to publish the word rate.
"""

import io
import re
from contextlib import redirect_stdout

import pytest

import run_benchmark
from baselines import WordTokenizer, word_split
from bpe import ByteBPE
from run_benchmark import load

# (file, oov words, word runs, published percentage)
ROWS = [("prose", 209, 516, "40.5"), ("code", 111, 227, "48.9"),
        ("unicode", 226, 249, "90.8")]


@pytest.fixture(scope="module")
def output():
    buffer = io.StringIO()
    with redirect_stdout(buffer):
        run_benchmark.main()
    return buffer.getvalue()


@pytest.fixture(scope="module")
def readme():
    path = run_benchmark.Path(__file__).parent.parent / "README.md"
    return " ".join(path.read_text(encoding="utf-8").split())


@pytest.fixture(scope="module")
def readme_body(readme):
    """Everything above the fixes log, which quotes retired figures on
    purpose — the dated entries are this project's version history."""
    return readme.split("## fixes")[0]


@pytest.fixture(scope="module")
def word_baseline():
    train = load("train/prose.txt") + "\n" + load("train/code.txt")
    budget = ByteBPE.train(train, run_benchmark.MAX_VOCAB).vocab_size
    return WordTokenizer.train(train, budget)


class TestThePaddingIsRealAndExact:
    def test_no_whitespace_run_is_ever_oov(self, word_baseline):
        # The premise: whitespace runs contribute to the denominator and
        # never to the numerator, on every file measured.
        for name, _, _, _ in ROWS:
            runs = word_split(load(f"heldout/{name}.txt"))
            missing = [r for r in runs
                       if r.isspace() and r not in word_baseline._ids]
            assert missing == [], (name, missing)

    def test_words_and_whitespace_runs_are_equal_in_number(self):
        # Why the dilution is exactly a factor of two rather than roughly one.
        for name, _, words, _ in ROWS:
            runs = word_split(load(f"heldout/{name}.txt"))
            assert sum(1 for r in runs if not r.isspace()) == words, name
            assert sum(1 for r in runs if r.isspace()) == words, name

    def test_the_retired_rate_is_exactly_half_the_word_rate(self, word_baseline):
        for name, oov, words, _ in ROWS:
            text = load(f"heldout/{name}.txt")
            runs = word_split(text)
            padded = oov / len(runs)
            assert padded == pytest.approx(oov / words / 2, rel=1e-12), name


class TestOovStatsCountsWordsOnly:
    def test_committed_corpus_rows(self, word_baseline):
        for name, oov, words, _ in ROWS:
            assert word_baseline.oov_stats(load(f"heldout/{name}.txt")) == \
                (oov, words), name

    def test_whitespace_runs_are_left_out_of_both_terms(self):
        tok = WordTokenizer.train("a a a b b c", 4)
        # "a z b q" has four words, two of them unknown; the three spaces
        # between them are not tokens this rate is about.
        assert tok.oov_stats("a z b q") == (2, 4)

    def test_every_word_unknown_reads_as_every_word(self):
        tok = WordTokenizer.train("a b c", 1)
        assert tok.oov_stats("a b") == (2, 2)

    def test_whitespace_only_and_empty_text_have_no_words(self):
        tok = WordTokenizer.train("a b", 10)
        assert tok.oov_stats("") == (0, 0)
        assert tok.oov_stats("   \n\t ") == (0, 0)


class TestRunPublishesTheWordRate:
    def test_rows_print_the_word_denominator_and_rate(self, output):
        for name, oov, words, pct in ROWS:
            assert f"heldout {name}: {oov}/{words} word runs are OOV " \
                   f"({pct}%)" in output, name

    def test_retired_padded_rows_are_gone(self, output):
        for stale in ["209/1032", "111/454", "226/498", "(20.3%)", "(24.4%)",
                      "(45.4%)"]:
            assert stale not in output, stale

    def test_section_says_whitespace_runs_are_excluded(self, output):
        section = output.split("=== baselines")[1].split("\n===")[0]
        assert "whitespace runs" in section
        assert "never unknown" in section


class TestReadmeStatesTheWordRate:
    def test_readme_carries_the_new_figure(self, readme):
        assert "40.5% unknown" in readme

    def test_readme_drops_the_padded_figure(self, readme_body, readme):
        for stale in ["20.3%", "24.4%", "45.4%"]:
            assert stale not in readme_body, stale
        # The fixes entry keeps them, as the figures the fix retired.
        assert "20.3% → 40.5%" in readme

    def test_readme_keeps_the_budget_point_at_the_new_rate(self, readme):
        # The 2026-09-03 finding still holds — the budget was never binding,
        # only the denominator moved.
        assert "40.5% is the ceiling" in readme
