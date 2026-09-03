"""The word baseline is measured under a vocab budget it cannot spend.

`WordTokenizer.train(text, n)` keeps the top n - 1 word types, so when the
training text has fewer than n - 1 distinct types the realized vocab is
smaller than the budget. On the committed corpus that is exactly what
happens, so the baselines section is not a matched-vocab comparison and must
not print itself as one — it has to state the vocab the word tokenizer
actually built, and say the budget went unspent.
"""

import io
import re
from contextlib import redirect_stdout

import pytest

import run_benchmark
from baselines import WordTokenizer, word_split
from bpe import ByteBPE
from run_benchmark import load


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
def word_baseline():
    train = load("train/prose.txt") + "\n" + load("train/code.txt")
    budget = ByteBPE.train(train, run_benchmark.MAX_VOCAB).vocab_size
    return WordTokenizer.train(train, budget), budget


class TestBudgetIsNotBinding:
    def test_train_stops_at_the_type_count_not_the_budget(self):
        # Four types (" ", "a", "b", "c") plus UNK is all a 100-slot budget
        # can buy from this text.
        tok = WordTokenizer.train("a a a b b c", 100)
        assert tok.vocab_size == 5
        assert tok.vocab_size < 100

    def test_committed_corpus_leaves_the_budget_unspent(self, word_baseline):
        word, budget = word_baseline
        assert word.vocab_size < budget

    def test_realized_vocab_is_every_type_in_training(self, word_baseline):
        word, _ = word_baseline
        train = load("train/prose.txt") + "\n" + load("train/code.txt")
        assert word.vocab_size == len(set(word_split(train))) + 1

    def test_raising_the_budget_changes_nothing(self, word_baseline):
        # The measured OOV rates are a ceiling, not a budget handicap: hand
        # the word tokenizer ten times the slots and it builds the same vocab.
        word, budget = word_baseline
        train = load("train/prose.txt") + "\n" + load("train/code.txt")
        richer = WordTokenizer.train(train, budget * 10)
        assert richer.vocab == word.vocab


class TestBaselinesSectionReportsTheRealVocab:
    def test_header_does_not_claim_a_matched_vocab(self, output):
        header = re.search(r"=== baselines .*? ===", output).group(0)
        assert "matched vocab" not in header

    def test_header_states_the_vocab_actually_built(self, output, word_baseline):
        word, _ = word_baseline
        header = re.search(r"=== baselines .*? ===", output).group(0)
        numbers = [int(n) for n in re.findall(r"\d+", header)]
        assert word.vocab_size in numbers, header

    def test_section_says_the_budget_went_unspent(self, output, word_baseline):
        word, budget = word_baseline
        section = output.split("=== baselines")[1].split("\n===")[0]
        assert str(budget) in section
        assert str(word.vocab_size) in section
        assert "unspent" in section

    def test_oov_rows_are_unchanged(self, output):
        # Nothing measured moves — the budget was never binding.
        for name, oov, total in [("prose", 209, 1032), ("code", 111, 454),
                                 ("unicode", 226, 498)]:
            assert f"heldout {name}: {oov}/{total} tokens are OOV" in output


class TestReadmeStatesTheComparisonHonestly:
    def test_readme_drops_the_same_vocab_size_claim(self, readme):
        assert "at the same vocab size" not in readme

    def test_readme_states_the_word_vocab(self, readme, word_baseline):
        word, _ = word_baseline
        assert str(word.vocab_size) in readme

    def test_readme_keeps_the_oov_figure(self, readme):
        assert "20.3% unknown" in readme
