"""The numeric gate is `min(cosine, numeric_match)`, so it flags through
two channels, not one.

At its tuned threshold `numeric_gated` flags 8 claims. Six are number
swaps the numeric channel zeroes. The other two are fabrications with no
numbers at all: they pass the numeric check with 1.0 and get flagged
because their sentence cosine sits below the threshold. The readme's
reading of the row said the gate catches only claims whose numbers the
context never states, which is refuted by its own `fabricated 2/6` cell.

Mechanism tests pin the split. Prose tests pin the readme to it, off
whitespace-normalized text so a line wrap cannot make them pass.
"""

import re
import subprocess
import sys
from pathlib import Path

import pytest

from groundedness.data import load_contexts
from groundedness.evaluate import best_operating_point, score_dataset
from groundedness.scorers import (
    METHODS,
    ContextBundle,
    extract_numbers,
    numeric_match,
    sentence_cosine,
)

PROJECT = Path(__file__).parent.parent
DATA = PROJECT / "data" / "contexts.jsonl"

# the two fabrications the gate flags on cosine alone
COSINE_CHANNEL_IDS = frozenset({"c07-6", "c09-5"})


@pytest.fixture(scope="module")
def contexts():
    return load_contexts(DATA)


@pytest.fixture(scope="module")
def bundles(contexts):
    return {context.id: ContextBundle(context.text) for context in contexts}


@pytest.fixture(scope="module")
def gate_flags(contexts):
    """(threshold, [ScoredClaim]) for what numeric_gated flags at its
    own best operating point."""
    scored = score_dataset(contexts, METHODS["numeric_gated"])
    threshold = best_operating_point(scored).threshold
    return threshold, [s for s in scored if s.score < threshold]


@pytest.fixture(scope="module")
def readme_text():
    return (PROJECT / "README.md").read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def readme_prose(readme_text):
    """The readme with runs of whitespace collapsed, so an assertion on a
    sentence does not depend on where the line happens to wrap. The
    `## fixes` section is cut out: it quotes the sentence being retired,
    and a test asserting that sentence is gone must not trip over its own
    changelog entry."""
    body = readme_text.split("\n## fixes")[0]
    return re.sub(r"\s+", " ", body)


class TestGateChannels:
    def test_gate_flags_eight_claims(self, gate_flags):
        _, flagged = gate_flags
        assert len(flagged) == 8

    def test_two_flags_come_from_the_cosine_channel(self, gate_flags, bundles):
        """The finding, restated as an invariant: some of what the gate
        catches has no numbers in it at all."""
        threshold, flagged = gate_flags
        cosine_only = []
        for s in flagged:
            bundle = bundles[s.context_id]
            if numeric_match(s.claim.text, bundle) == 1.0:
                assert sentence_cosine(s.claim.text, bundle) < threshold, s.claim.id
                cosine_only.append(s.claim.id)
        assert set(cosine_only) == COSINE_CHANNEL_IDS

    def test_the_cosine_channel_claims_state_no_numbers(self, gate_flags, bundles):
        """Not "their numbers happen to check out" — they assert no
        number, so `numeric_match` returns its no-evidence 1.0."""
        _, flagged = gate_flags
        for s in flagged:
            if s.claim.id in COSINE_CHANNEL_IDS:
                assert extract_numbers(s.claim.text) == set(), s.claim.id
                assert numeric_match(s.claim.text, bundles[s.context_id]) == 1.0

    def test_the_cosine_channel_claims_are_the_two_fabrications(self, gate_flags):
        fabricated = {s.claim.id for s in gate_flags[1] if s.claim.category == "fabricated"}
        assert fabricated == COSINE_CHANNEL_IDS

    def test_the_other_six_flags_are_number_swaps_the_numeric_channel_zeroes(
        self, gate_flags, bundles
    ):
        _, flagged = gate_flags
        rest = [s for s in flagged if s.claim.id not in COSINE_CHANNEL_IDS]
        assert len(rest) == 6
        for s in rest:
            assert s.claim.category == "number_swap", s.claim.id
            assert numeric_match(s.claim.text, bundles[s.context_id]) == 0.0, s.claim.id

    def test_a_pure_numeric_detector_catches_six_not_eight(self, contexts, gate_flags):
        """What the retired sentence described: numeric_match alone at the
        same threshold. It misses both fabrications, so the gate's extra
        two catches cannot be numeric."""
        threshold, _ = gate_flags
        pure = score_dataset(contexts, lambda text, bundle: numeric_match(text, bundle))
        flagged = {s.claim.id for s in pure if s.score < threshold}
        assert len(flagged) == 6
        assert flagged.isdisjoint(COSINE_CHANNEL_IDS)
        assert all(
            s.claim.category == "number_swap" for s in pure if s.claim.id in flagged
        )

    def test_negation_aware_flags_the_same_two_on_the_same_channel(self, contexts):
        """The published `fabricated 2/6` cell is identical in both gated
        columns because it is the same cosine channel in both."""
        scored = score_dataset(contexts, METHODS["negation_aware"])
        threshold = best_operating_point(scored).threshold
        fabricated = {
            s.claim.id
            for s in scored
            if s.score < threshold and s.claim.category == "fabricated"
        }
        assert fabricated == COSINE_CHANNEL_IDS


class TestReadmeReading:
    def test_the_only_numeric_claim_is_gone(self, readme_prose):
        assert "catching only claims whose numbers the context never states" not in (
            readme_prose
        )

    def test_the_fixes_entry_still_quotes_the_retired_sentence(self, readme_text):
        fixes = readme_text.split("\n## fixes")[1]
        assert "catching only claims whose numbers the context never states" in fixes

    def test_the_reading_names_both_channels(self, readme_prose):
        assert "6 of its 8 flags are numeric" in readme_prose
        assert "c07-6 and c09-5" in readme_prose

    def test_the_reading_keeps_the_c06_5_miss(self, readme_prose):
        assert "the miss is c06-5" in readme_prose
        assert "half its numbers check out" in readme_prose

    def test_the_category_block_is_what_main_prints(self, readme_text):
        result = subprocess.run(
            [sys.executable, "main.py"],
            cwd=PROJECT,
            capture_output=True,
            text=True,
            timeout=120,
        )
        assert result.returncode == 0, result.stderr
        table = result.stdout.split("positives, want 0.00)\n")[1].strip()
        assert table in readme_text
        # the two cells the reading now explains
        assert "fabricated         unsup   6" in table
        assert "number_swap        unsup   7" in table
