"""The cross-script per-character gap is not training's doing alone.

The script-cost table divides each script's tokens per character by
english's, and the headline reads the whole multiplier as a consequence of
what the tokenizer trained on. It isn't. For every non-latin row in the
sheet the mixed tokenizer emits exactly the token count an untrained
vocab-256 tokenizer does — no merge fires on them at all — so training moves
their numerator by zero tokens. What training moves is the english
denominator, 1.000 -> 0.335. The rest of the multiplier is utf-8 charging
two to three bytes for a character english buys with one, and an untrained
tokenizer already shows it. So the run has to print that control, and the
readme has to split the gap into both factors instead of handing all of it
to training.
"""

import io
import re
from contextlib import redirect_stdout

import pytest

import run_benchmark
from bpe import ByteBPE
from metrics import tokens_per_char, utf8_bytes
from run_benchmark import load

# Every script in the sheet the tokenizer learned nothing for.
UNMOVED = ["russian", "greek", "japanese", "chinese", "korean", "arabic",
           "hindi"]


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
def repo_readme():
    """The index table one directory up carries the same takeaway."""
    path = run_benchmark.Path(__file__).parent.parent.parent / "README.md"
    row = [line for line in path.read_text(encoding="utf-8").splitlines()
           if "04-bpe-tokenizer/" in line]
    assert len(row) == 1, row
    return row[0]


@pytest.fixture(scope="module")
def script_section(output):
    return output.split("=== script cost")[1].split("\n===")[0]


@pytest.fixture(scope="module")
def tokenizers():
    train = load("train/prose.txt") + "\n" + load("train/code.txt")
    return ByteBPE.train(train, run_benchmark.MAX_VOCAB), ByteBPE()


@pytest.fixture(scope="module")
def script_lines():
    rows = {}
    for line in load("heldout/unicode.txt").splitlines():
        if ": " not in line:
            continue
        label, _, body = line.partition(": ")
        rows[label.lower()] = body
    return rows


class TestTrainingMovesNoNonLatinToken:
    def test_no_merge_fires_on_the_non_latin_rows(self, tokenizers, script_lines):
        mixed, untrained = tokenizers
        for label in UNMOVED:
            body = script_lines[label]
            assert len(mixed.encode(body)) == len(untrained.encode(body)), label
            # Untrained means one token per utf-8 byte, nothing else.
            assert len(mixed.encode(body)) == utf8_bytes(body), label

    def test_english_is_the_only_side_training_moves(self, tokenizers):
        mixed, untrained = tokenizers
        prose = load("heldout/prose.txt")
        assert len(untrained.encode(prose)) == utf8_bytes(prose) == 3106
        assert len(mixed.encode(prose)) == 1041


class TestTheGapSurvivesWithZeroMerges:
    def test_cjk_still_costs_three_times_english_untrained(self, tokenizers,
                                                           script_lines):
        _, untrained = tokenizers
        prose = load("heldout/prose.txt")
        english = tokens_per_char(prose, len(untrained.encode(prose)))
        for label in ["chinese", "japanese"]:
            body = script_lines[label]
            tpc = tokens_per_char(body, len(untrained.encode(body)))
            assert tpc / english == pytest.approx(3.0, abs=0.01), label

    def test_the_trained_gap_is_byte_width_times_english_compression(
            self, tokenizers, script_lines):
        mixed, untrained = tokenizers
        prose = load("heldout/prose.txt")
        body = script_lines["chinese"]

        def ratio(tok):
            return (tokens_per_char(body, len(tok.encode(body)))
                    / tokens_per_char(prose, len(tok.encode(prose))))

        trained, byte_width = ratio(mixed), ratio(untrained)
        compression = (len(untrained.encode(prose))
                       / len(mixed.encode(prose)))
        assert trained == pytest.approx(9.0, abs=0.05)
        assert byte_width == pytest.approx(3.0, abs=0.01)
        assert compression == pytest.approx(2.98, abs=0.01)
        assert trained == pytest.approx(byte_width * compression, rel=1e-9)


class TestRunPrintsTheUntrainedControl:
    def test_section_carries_an_untrained_column(self, script_section):
        assert "untrained" in script_section

    def test_untrained_column_prints_the_vocab_256_rates(self, script_section):
        # chinese and japanese are 3.000 tokens per character either way.
        for label in ["chinese", "japanese"]:
            row = re.search(rf"^\s*{label}\s+(\S+).*?(\S+)\s*$",
                            script_section, re.MULTILINE)
            assert row, label
            assert row.group(1) == "3.000", label
        assert "1.000" in script_section, "untrained english is one byte, one token"

    def test_section_says_training_bought_the_unmoved_rows_nothing(
            self, script_section):
        assert "byte-identical" in script_section
        for label in UNMOVED:
            assert label in script_section


class TestReadmeSplitsTheGapIntoBothFactors:
    def test_readme_drops_the_purely_training_claim(self, readme):
        assert "purely because of what the tokenizer saw during training" \
            not in readme

    def test_readme_states_the_untrained_control(self, readme):
        assert "untrained" in readme
        assert "3.0x" in readme

    def test_readme_says_no_merge_fires_on_cjk(self, readme):
        assert "byte-identical" in readme


class TestRepoIndexRowSplitsItToo:
    def test_row_does_not_hand_the_whole_gap_to_training(self, repo_readme):
        assert "when training never saw it" not in repo_readme

    def test_row_names_the_byte_width_half(self, repo_readme):
        assert "9x English" in repo_readme
        assert "3x" in repo_readme
