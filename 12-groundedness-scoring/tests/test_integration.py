"""End-to-end checks over the committed dataset: structural properties
the authored categories guarantee, and the entry point itself."""

import subprocess
import sys
from pathlib import Path

import pytest

from groundedness.data import load_contexts
from groundedness.evaluate import (
    auc,
    best_operating_point,
    mean_score_by_support,
    score_dataset,
)
from groundedness.scorers import METHODS, ContextBundle, numeric_match

PROJECT = Path(__file__).parent.parent
DATA = PROJECT / "data" / "contexts.jsonl"


@pytest.fixture(scope="module")
def contexts():
    return load_contexts(DATA)


@pytest.fixture(scope="module")
def scored_by_method(contexts):
    return {name: score_dataset(contexts, scorer) for name, scorer in METHODS.items()}


class TestFullPipeline:
    def test_one_score_per_claim_all_bounded(self, scored_by_method):
        for name, scored in scored_by_method.items():
            assert len(scored) == 60, name
            assert all(0.0 <= s.score <= 1.0 for s in scored), name

    def test_deterministic(self, contexts):
        for name, scorer in METHODS.items():
            first = [s.score for s in score_dataset(contexts, scorer)]
            second = [s.score for s in score_dataset(contexts, scorer)]
            assert first == second, name

    def test_verbatim_claims_score_one_everywhere(self, scored_by_method):
        for name, scored in scored_by_method.items():
            verbatim = [s for s in scored if s.claim.category == "verbatim"]
            assert len(verbatim) == 7
            for s in verbatim:
                assert s.score == pytest.approx(1.0), (name, s.claim.id)

    def test_negation_aware_zeroes_every_negation_flip(self, scored_by_method):
        flips = [
            s
            for s in scored_by_method["negation_aware"]
            if s.claim.category == "negation_flip"
        ]
        assert len(flips) == 7
        assert all(s.score == 0.0 for s in flips)

    def test_negation_aware_zeroes_every_negated_paraphrase(self, scored_by_method):
        # the price of the parity heuristic, pinned so it stays visible
        traps = [
            s
            for s in scored_by_method["negation_aware"]
            if s.claim.category == "negated_paraphrase"
        ]
        assert len(traps) == 4
        assert all(s.score == 0.0 for s in traps)

    def test_every_number_swap_fails_the_numeric_gate(self, contexts):
        for context in contexts:
            bundle = ContextBundle(context.text)
            for claim in context.claims:
                if claim.category == "number_swap":
                    assert numeric_match(claim.text, bundle) < 1.0, claim.id

    def test_bag_identical_antonym_flips_look_verbatim_to_cosine(
        self, scored_by_method
    ):
        # c04-5 and c09-6 reorder tokens without changing the bag, so
        # every bag-of-words scorer hands them a perfect score
        by_id = {s.claim.id: s.score for s in scored_by_method["sentence_cosine"]}
        assert by_id["c04-5"] == pytest.approx(1.0)
        assert by_id["c09-6"] == pytest.approx(1.0)

    def test_cosine_ranks_hallucinations_above_truth_here(self, scored_by_method):
        # the headline: on minimal-edit hallucinations, surface cosine is
        # worse than a coin flip, and mean unsupported beats mean supported
        scored = scored_by_method["sentence_cosine"]
        assert auc(scored) < 0.5
        mean_sup, mean_unsup = mean_score_by_support(scored)
        assert mean_unsup > mean_sup

    def test_negation_aware_separates_best(self, scored_by_method):
        aucs = {name: auc(scored) for name, scored in scored_by_method.items()}
        assert max(aucs, key=lambda name: aucs[name]) == "negation_aware"
        mean_sup, mean_unsup = mean_score_by_support(
            scored_by_method["negation_aware"]
        )
        assert mean_sup > mean_unsup

    def test_numeric_gate_has_a_clean_precision_point(self, scored_by_method):
        point = best_operating_point(scored_by_method["numeric_gated"])
        assert point.precision == 1.0
        assert point.false_positive_rate == 0.0


class TestEntryPoint:
    def test_main_runs_and_reports(self):
        result = subprocess.run(
            [sys.executable, "main.py"],
            cwd=PROJECT,
            capture_output=True,
            text=True,
            timeout=120,
        )
        assert result.returncode == 0, result.stderr
        out = result.stdout
        assert "10 contexts, 60 claims (25 supported, 35 unsupported)" in out
        assert "negation_aware" in out
        assert "antonym_flip" in out
        # rerun is byte-identical
        again = subprocess.run(
            [sys.executable, "main.py"],
            cwd=PROJECT,
            capture_output=True,
            text=True,
            timeout=120,
        )
        assert again.stdout == out
