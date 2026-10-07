"""Published scores carry no sub-1e-12 detail, so the AUC's tie
accounting is right and the numbers reproduce on any interpreter.

`auc` counts a tie by exact float equality. The tf-idf cosine lands a
few ULP either side of its true value, and the claims that matter most
here sit exactly on 1.0: the seven verbatim quotes are self-matches, and
c01-5, c04-5 and c09-6 carry the same content-token bag as the sentence
they match, so their cosine is mathematically 1.0 too. All 21 of those
supported x unsupported pairs are real ties. With raw cosines only six
of them compared equal and the other fifteen were scored as strict wins
or losses worth 1e-16, in whichever direction the float summation
happened to round -- which changed between python 3.11 and 3.12.

Rounding the cosine at the boundary collapses the noise band. The tests
below pin the invariant, the three AUC values that moved, the operating
point that moved with them, and the readme to what `main.py` prints.
"""

import re
import subprocess
import sys
from pathlib import Path

import pytest

from groundedness.data import load_contexts
from groundedness.evaluate import auc, best_operating_point, score_dataset
from groundedness.reuse import tokenize
from groundedness.scorers import METHODS, ContextBundle

PROJECT = Path(__file__).parent.parent
DATA = PROJECT / "data" / "contexts.jsonl"

# everything whose in-vocabulary token bag equals its best sentence's,
# which is what makes its cosine mathematically exactly 1: the seven
# verbatim quotes, the two bag-identical reorderings, and c01-5, which
# adds only "not" -- a token the context never uses, so the index has no
# idf for it and drops it from the query vector entirely
EXACT_ONE_IDS = frozenset(
    {
        "c01-1",
        "c02-1",
        "c03-1",
        "c04-1",
        "c06-1",
        "c07-1",
        "c08-1",
        "c01-5",
        "c04-5",
        "c09-6",
    }
)

PUBLISHED_AUC = {
    "overlap": 0.521,
    "sentence_cosine": 0.433,
    "numeric_gated": 0.561,
    "negation_aware": 0.626,
}


@pytest.fixture(scope="module")
def contexts():
    return load_contexts(DATA)


@pytest.fixture(scope="module")
def scored_by_method(contexts):
    return {name: score_dataset(contexts, scorer) for name, scorer in METHODS.items()}


@pytest.fixture(scope="module")
def readme_text():
    return (PROJECT / "README.md").read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def readme_prose(readme_text):
    body = readme_text.split("\n## fixes")[0]
    return re.sub(r"\s+", " ", body)


class TestNoFloatNoise:
    def test_the_cosine_carries_no_detail_below_1e_12(self, contexts):
        """The invariant. `overlap` and `numeric_match` are ratios of
        small integers and reproduce bit for bit anywhere; the cosine is
        the only summed quantity, so it is the only one that has to be
        settled."""
        for context in contexts:
            bundle = ContextBundle(context.text)
            for claim in context.claims:
                score, _ = bundle.best_sentence(claim.text)
                assert score == round(score, 12), (claim.id, score)

    def test_bag_identical_claims_score_exactly_one(self, contexts):
        """Not approx(1.0) -- exactly 1.0. `auc` compares with ==, so an
        ULP short of one is a different score to it. The structural
        reason is checked alongside the score: drop the tokens the index
        has no idf for and the claim is the sentence's bag."""
        for context in contexts:
            bundle = ContextBundle(context.text)
            for claim in context.claims:
                if claim.id not in EXACT_ONE_IDS:
                    continue
                _, best = bundle.best_sentence(claim.text)
                in_vocab = [t for t in tokenize(claim.text) if t in bundle.index.idf]
                assert sorted(in_vocab) == sorted(tokenize(best)), claim.id
                assert METHODS["sentence_cosine"](claim.text, bundle) == 1.0, claim.id

    def test_no_pair_is_separated_by_float_noise(self, scored_by_method):
        """Two claims are either tied or meaningfully apart. A gap of
        1e-16 is neither, and it is what made the AUC interpreter
        dependent."""
        for name, scored in scored_by_method.items():
            supported = [s for s in scored if s.claim.supported]
            unsupported = [s for s in scored if not s.claim.supported]
            for u in unsupported:
                for s in supported:
                    gap = abs(u.score - s.score)
                    assert gap == 0.0 or gap > 1e-9, (name, u.claim.id, s.claim.id, gap)

    def test_the_21_pairs_at_one_all_count_as_ties(self, scored_by_method):
        """Seven verbatim quotes against the three unsupported claims
        that also sit on 1.0: 21 pairs, every one a tie worth half."""
        scored = scored_by_method["sentence_cosine"]
        at_one = [s for s in scored if s.score == 1.0]
        supported = [s for s in at_one if s.claim.supported]
        unsupported = [s for s in at_one if not s.claim.supported]
        assert len(supported) == 7
        assert len(unsupported) == 3
        assert {s.claim.id for s in at_one} == EXACT_ONE_IDS
        assert len(supported) * len(unsupported) == 21


class TestPublishedNumbers:
    def test_auc_per_method(self, scored_by_method):
        for name, expected in PUBLISHED_AUC.items():
            assert round(auc(scored_by_method[name]), 3) == expected, name

    def test_sentence_cosine_cannot_separate_its_three_claims_at_one(
        self, scored_by_method
    ):
        """The operating point that moved. The sweep's threshold used to
        land inside the noise band and flag c01-5 for free; with the band
        gone, no threshold flags c01-5 without flagging all seven
        verbatim quotes, so recall is 0.914, not 0.943."""
        point = best_operating_point(scored_by_method["sentence_cosine"])
        assert point.threshold == 1.0
        assert round(point.precision, 3) == 0.640
        assert round(point.recall, 3) == 0.914
        assert round(point.false_positive_rate, 3) == 0.720
        assert round(point.youden_j, 3) == 0.194
        flagged = {
            s.claim.id
            for s in scored_by_method["sentence_cosine"]
            if s.score < point.threshold
        }
        assert flagged.isdisjoint(EXACT_ONE_IDS)

    def test_sentence_cosine_misses_one_negation_flip(self, scored_by_method):
        """The category cell that moved with it: 7/7 -> 6/7, the miss
        being c01-5."""
        point = best_operating_point(scored_by_method["sentence_cosine"])
        flips = [
            s
            for s in scored_by_method["sentence_cosine"]
            if s.claim.category == "negation_flip"
        ]
        missed = [s.claim.id for s in flips if s.score >= point.threshold]
        assert missed == ["c01-5"]

    def test_overlap_auc_did_not_move(self, scored_by_method):
        """Overlap is a ratio of integers, so it never had the problem
        and its row is unchanged."""
        assert round(auc(scored_by_method["overlap"]), 3) == 0.521


class TestReadmeMatchesTheRun:
    def test_method_table_is_what_main_prints(self, readme_text):
        result = subprocess.run(
            [sys.executable, "main.py"],
            cwd=PROJECT,
            capture_output=True,
            text=True,
            timeout=120,
        )
        assert result.returncode == 0, result.stderr
        table = result.stdout.split("(flag when score < threshold; threshold picked by max Youden J)\n")[
            1
        ].split("\n\n")[0]
        assert table.strip() in readme_text

    def test_the_prose_quotes_the_new_aucs(self, readme_prose):
        assert "cosine at 0.433 is worse than a coin flip" in readme_prose
        assert "AUC 0.626 with both consistency checks stacked" in readme_prose

    def test_the_retired_aucs_are_gone_from_the_prose(self, readme_prose):
        assert "cosine at 0.432" not in readme_prose
        assert "AUC 0.622 with both" not in readme_prose
