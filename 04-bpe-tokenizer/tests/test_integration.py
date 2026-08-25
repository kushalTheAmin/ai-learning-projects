"""End-to-end checks: the real committed corpus through the full pipeline,
and the benchmark entry point's output obeying the bounds it claims."""

import io
import re
from contextlib import redirect_stdout

import pytest

import run_benchmark
from bpe import ByteBPE
from run_benchmark import load


@pytest.fixture(scope="module")
def output():
    buffer = io.StringIO()
    with redirect_stdout(buffer):
        run_benchmark.main()
    return buffer.getvalue()


def section_of(output, header):
    """Text between a section header line and the next section header."""
    return output.split(f"=== {header}")[1].split("\n===")[0]


class TestFullPipelineOnRealData:
    def test_train_encode_decode_on_committed_corpus(self):
        train_text = load("train/prose.txt")
        bpe = ByteBPE.train(train_text, 400)
        assert bpe.vocab_size == 400
        for name in ["heldout/prose.txt", "heldout/code.txt", "heldout/unicode.txt"]:
            text = load(name)
            ids = bpe.encode(text)
            assert bpe.decode(ids) == text
            assert all(0 <= i < bpe.vocab_size for i in ids)
        heldout_prose = load("heldout/prose.txt")
        n_tokens = len(bpe.encode(heldout_prose))
        assert 0 < n_tokens < len(heldout_prose.encode("utf-8"))


class TestBenchmarkOutput:
    def test_all_sections_present(self, output):
        for header in ["=== corpus ===", "=== vocab size vs compression",
                       "=== domain transfer", "=== script cost",
                       "=== baselines", "=== cost"]:
            assert header in output

    def test_round_trip_claims(self, output):
        assert "bpe round-trips every file exactly: True" in output
        assert "word baseline is lossy on heldout: True" in output

    def test_token_count_drops_as_vocab_grows(self, output):
        section = section_of(output, "vocab size vs compression")
        tokens = [int(m.group(1))
                  for m in re.finditer(r"^\s*\d+\s+(\d+)\s", section, re.MULTILINE)]
        assert len(tokens) == len(run_benchmark.VOCAB_SWEEP)
        assert all(a > b for a, b in zip(tokens, tokens[1:]))

    def test_mixed_training_beats_prose_training_on_code(self, output):
        section = section_of(output, "domain transfer")
        code_row = re.search(r"^\s*code\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)",
                             section, re.MULTILINE)
        prose_trained, mixed_full, mixed_matched = map(float, code_row.groups())
        assert mixed_full > prose_trained
        # Still true with the vocab-size advantage removed.
        assert mixed_matched > prose_trained

    def test_cjk_costs_more_tokens_per_char_than_english(self, output):
        section = section_of(output, "script cost")

        def tpc(label):
            row = re.search(rf"^\s*{label}\s+([\d.]+)", section, re.MULTILINE)
            return float(row.group(1))

        english = tpc("english prose")
        assert tpc("chinese") > 2 * english
        assert tpc("japanese") > 2 * english
