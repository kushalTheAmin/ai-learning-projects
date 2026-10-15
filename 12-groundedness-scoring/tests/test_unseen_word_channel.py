"""An added word the context never uses costs overlap and costs the
cosine nothing.

`TfidfIndex.search` builds the claim vector out of the index vocabulary
only: a term with no idf is dropped before the vector is normalized, so
`sentence_cosine` cannot see a word the context never uses. That is why
c01-5 scores exactly 1.0 while adding "not", and why stripping "most"
from c02-5 and "before" from c07-5 leaves both cosines byte-identical.
The readme explained the antonym_flip row's 0.50 as "which each
introduce a word the context never uses" — the overlap channel's reason,
published for both lexical columns. On the cosine side the 0.50 is
earned by the token each claim drops, not the one it adds.

Mechanism tests pin both channels. Prose tests pin the readme to them,
off whitespace-normalized text so a line wrap cannot make them pass.
"""

import re
from pathlib import Path

import pytest

from groundedness.data import load_contexts
from groundedness.reuse import tokenize
from groundedness.scorers import (
    ContextBundle,
    content_tokens,
    overlap,
    sentence_cosine,
)

PROJECT = Path(__file__).parent.parent
DATA = PROJECT / "data" / "contexts.jsonl"

# a token no context in the dataset uses
UNSEEN = "flibbertigibbet"

# claim id -> (context id, the word it adds, the in-vocabulary tokens it
# drops from its best-matching sentence)
ADDED_WORD = {
    "c02-5": ("ctx-02", "most", {"least"}),
    "c07-5": ("ctx-07", "before", {"only", "after"}),
}


@pytest.fixture(scope="module")
def contexts():
    return load_contexts(DATA)


@pytest.fixture(scope="module")
def bundles(contexts):
    return {context.id: ContextBundle(context.text) for context in contexts}


@pytest.fixture(scope="module")
def claims(contexts):
    return {
        claim.id: (context.id, claim.text)
        for context in contexts
        for claim in context.claims
    }


@pytest.fixture(scope="module")
def readme_text():
    return (PROJECT / "README.md").read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def readme_prose(readme_text):
    """The readme body with runs of whitespace collapsed. The `## fixes`
    section is cut out: it quotes the retired sentence, and a test
    asserting that sentence is gone must not trip over the changelog."""
    body = readme_text.split("\n## fixes")[0]
    return re.sub(r"\s+", " ", body)


def strip_word(text: str, word: str) -> str:
    return " ".join(
        part for part in text.split() if word not in part.casefold()
    )


class TestTheCosineCannotSeeAnAddedWord:
    def test_an_unseen_word_never_moves_any_claims_cosine(self, contexts, bundles):
        """The invariant, over every claim in the dataset: a term the
        index has no idf for is dropped before normalization, so it
        contributes nothing either way."""
        for context in contexts:
            bundle = bundles[context.id]
            for claim in context.claims:
                before = sentence_cosine(claim.text, bundle)
                after = sentence_cosine(f"{claim.text} {UNSEEN}", bundle)
                assert after == before, claim.id

    def test_the_unseen_token_really_is_unseen(self, bundles):
        for context_id, bundle in bundles.items():
            assert UNSEEN not in bundle.index.idf, context_id

    def test_stripping_the_added_word_leaves_the_cosine_identical(
        self, claims, bundles
    ):
        """c02-5 and c07-5 sit below 1.0 on the cosine channel for a
        reason that is not the word they add."""
        for claim_id, (context_id, word, _) in ADDED_WORD.items():
            bundle = bundles[context_id]
            _, text = claims[claim_id]
            assert word in text.casefold(), claim_id
            with_word = sentence_cosine(text, bundle)
            without = sentence_cosine(strip_word(text, word), bundle)
            assert without == with_word, claim_id
            assert with_word < 1.0, claim_id

    def test_what_costs_them_the_cosine_is_the_token_they_drop(
        self, claims, bundles
    ):
        """The real mechanism: their best-matching sentence carries a
        token they do not, and putting it back scores exactly 1.0."""
        for claim_id, (context_id, word, dropped) in ADDED_WORD.items():
            bundle = bundles[context_id]
            _, text = claims[claim_id]
            _, best = bundle.best_sentence(text)
            assert best is not None, claim_id
            missing = set(tokenize(best)) - set(tokenize(text))
            assert missing == dropped, claim_id
            assert sentence_cosine(best, bundle) == 1.0, claim_id


class TestOverlapIsTheChannelTheAddedWordCosts:
    def test_the_added_word_is_the_whole_overlap_shortfall(self, claims, bundles):
        for claim_id, (context_id, word, _) in ADDED_WORD.items():
            bundle = bundles[context_id]
            _, text = claims[claim_id]
            assert overlap(text, bundle) < 1.0, claim_id
            assert overlap(strip_word(text, word), bundle) == 1.0, claim_id


class TestC01_5IsNotBagIdentical:
    def test_its_bag_differs_from_its_sentence_by_the_added_not(
        self, claims, bundles
    ):
        context_id, text = claims["c01-5"]
        bundle = bundles[context_id]
        _, best = bundle.best_sentence(text)
        assert set(content_tokens(text)) != set(content_tokens(best))
        assert set(content_tokens(text)) - set(content_tokens(best)) == {"not"}

    def test_the_context_has_no_idf_for_not(self, bundles):
        assert "not" not in bundles["ctx-01"].index.idf

    def test_it_scores_exactly_one_on_cosine_and_under_one_on_overlap(
        self, claims, bundles
    ):
        context_id, text = claims["c01-5"]
        bundle = bundles[context_id]
        assert sentence_cosine(text, bundle) == 1.0
        assert overlap(text, bundle) < 1.0


class TestReadmeNamesBothChannels:
    def test_the_overlap_only_reason_is_gone_from_the_prose(self, readme_prose):
        assert "which each introduce a word the context never uses" not in (
            readme_prose
        )

    def test_the_fixes_entry_still_quotes_the_retired_reason(self, readme_text):
        fixes = readme_text.split("\n## fixes")[1]
        assert "introduce a word the context never uses" in fixes

    def test_the_tradeoff_bullet_splits_the_050_by_channel(self, readme_prose):
        assert "the cosine is blind to that word" in readme_prose
        assert "the token each one drops" in readme_prose

    def test_the_reading_says_why_cosine_keeps_c01_5(self, readme_prose):
        assert "c01-5 is not bag-identical" in readme_prose
        assert "a term the context never uses has no idf" in readme_prose

    def test_the_bullets_the_earlier_fixes_pinned_are_untouched(self, readme_prose):
        assert "bag-identical reorderings (0/2 at every threshold" in readme_prose
        assert "c02-5 and c07-5" in readme_prose
        assert "no threshold fixes a score that is identical to the truth's" in (
            readme_prose
        )
