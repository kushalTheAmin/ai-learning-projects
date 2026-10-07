"""The two bag-identical reorderings are 0/2, not 0.50.

`antonym_flip` holds four claims and the lexical columns catch two of
them, so the row reads 2/4 (0.50). The two it catches are c02-5 and
c07-5, which each introduce a content token the context never uses
("most", "before"). The two the tradeoffs bullet was naming are c04-5
and c09-6, whose content-token bag IS their best-matching sentence's:
every scorer hands them exactly 1.0, tied with all 7 verbatim quotes, so
no threshold flags either one without flagging the truth too. The bullet
published 0.50 recall for that subclass, which is the category's number,
not the subclass's, and it contradicted the reading one screen above
("no threshold fixes a score that is identical to the truth's").

Mechanism tests pin the subclass's own 0/2. Prose tests pin the readme
to it, off whitespace-normalized text so a line wrap cannot make them
pass.
"""

import re
from pathlib import Path

import pytest

from groundedness.data import load_contexts
from groundedness.evaluate import (
    best_operating_point,
    flag_rates_by_category,
    operating_point,
    score_dataset,
)
from groundedness.scorers import METHODS, ContextBundle, content_tokens

PROJECT = Path(__file__).parent.parent
DATA = PROJECT / "data" / "contexts.jsonl"

# the antonym flips that reorder a true sentence without touching its
# bag of words, and the two that do introduce a new word
REORDERING_IDS = frozenset({"c04-5", "c09-6"})
NEW_WORD_IDS = frozenset({"c02-5", "c07-5"})
VERBATIM_COUNT = 7


@pytest.fixture(scope="module")
def contexts():
    return load_contexts(DATA)


@pytest.fixture(scope="module")
def bundles(contexts):
    return {context.id: ContextBundle(context.text) for context in contexts}


@pytest.fixture(scope="module")
def scored_by_method(contexts):
    return {
        name: score_dataset(contexts, scorer) for name, scorer in METHODS.items()
    }


@pytest.fixture(scope="module")
def readme_text():
    return (PROJECT / "README.md").read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def readme_prose(readme_text):
    """The readme body with runs of whitespace collapsed. The `## fixes`
    section is cut out: it quotes the retired claim, and a test asserting
    that claim is gone must not trip over its own changelog entry."""
    body = readme_text.split("\n## fixes")[0]
    return re.sub(r"\s+", " ", body)


class TestTheSubclassIsBagIdentical:
    def test_the_two_reorderings_carry_their_sentences_own_bag(
        self, contexts, bundles
    ):
        """What makes the subclass a subclass: nothing a bag-of-words
        scorer looks at changed, only the order."""
        seen = set()
        for context in contexts:
            for claim in context.claims:
                if claim.id not in REORDERING_IDS:
                    continue
                bundle = bundles[context.id]
                _, best = bundle.best_sentence(claim.text)
                assert best is not None
                assert set(content_tokens(claim.text)) == set(content_tokens(best))
                seen.add(claim.id)
        assert seen == set(REORDERING_IDS)

    def test_the_other_two_antonym_flips_each_add_an_unseen_word(
        self, contexts, bundles
    ):
        """c02-5 and c07-5 are catchable for one reason: a word the
        context never uses. That is the whole 0.50."""
        seen = {}
        for context in contexts:
            for claim in context.claims:
                if claim.category != "antonym_flip":
                    continue
                unseen = set(content_tokens(claim.text)) - bundles[context.id].content
                seen[claim.id] = unseen
        assert set(seen) == REORDERING_IDS | NEW_WORD_IDS
        for claim_id in REORDERING_IDS:
            assert seen[claim_id] == set(), claim_id
        assert seen["c02-5"] == {"most"}
        assert seen["c07-5"] == {"before"}


class TestTheSubclassScoresZeroRecall:
    def test_every_method_scores_them_exactly_one(self, scored_by_method):
        for name, scored in scored_by_method.items():
            for s in scored:
                if s.claim.id in REORDERING_IDS:
                    assert s.score == 1.0, (name, s.claim.id, s.score)

    def test_they_tie_every_verbatim_quote(self, scored_by_method):
        """Indistinguishable from the truth, not merely close to it."""
        for name, scored in scored_by_method.items():
            verbatim = [s.score for s in scored if s.claim.category == "verbatim"]
            assert len(verbatim) == VERBATIM_COUNT, name
            assert set(verbatim) == {1.0}, name

    def test_neither_is_flagged_at_any_tuned_threshold(self, scored_by_method):
        for name, scored in scored_by_method.items():
            threshold = best_operating_point(scored).threshold
            flagged = {
                s.claim.id
                for s in scored
                if s.claim.id in REORDERING_IDS and s.score < threshold
            }
            assert flagged == set(), (name, threshold)

    def test_no_threshold_catches_either_without_flagging_the_truth(
        self, scored_by_method
    ):
        """The reading's claim, as an invariant over the whole sweep: the
        only thresholds that reach the subclass flag all 7 verbatim
        quotes too, so they buy J <= 0 — there is no operating point at
        which the subclass's recall is anything but 0."""
        for name, scored in scored_by_method.items():
            candidates = sorted({s.score for s in scored})
            candidates.append(candidates[-1] + 1.0)
            reached = 0
            for threshold in candidates:
                caught = [
                    s
                    for s in scored
                    if s.claim.id in REORDERING_IDS and s.score < threshold
                ]
                if not caught:
                    continue
                reached += 1
                assert len(caught) == 2, (name, threshold)
                verbatim = sum(
                    1
                    for s in scored
                    if s.claim.category == "verbatim" and s.score < threshold
                )
                assert verbatim == VERBATIM_COUNT, (name, threshold)
                assert operating_point(scored, threshold).youden_j <= 0.0, (
                    name,
                    threshold,
                )
            assert reached > 0, name

    def test_the_category_row_two_of_four_is_the_other_two(self, scored_by_method):
        """The 0.50 the bullet borrowed, traced to the claims that earn
        it. The gated columns are 0/4 and catch neither pair."""
        for name, scored in scored_by_method.items():
            threshold = best_operating_point(scored).threshold
            flagged, total = flag_rates_by_category(scored, threshold)["antonym_flip"]
            assert total == 4, name
            caught = {
                s.claim.id
                for s in scored
                if s.claim.category == "antonym_flip" and s.score < threshold
            }
            if name in {"overlap", "sentence_cosine"}:
                assert flagged == 2, name
                assert caught == set(NEW_WORD_IDS), name
            else:
                assert flagged == 0, name
                assert caught == set(), name


class TestReadmeTradeoff:
    def test_the_borrowed_rate_is_gone(self, readme_prose):
        assert "bag-identical reorderings (0.50 recall at best)" not in readme_prose

    def test_the_fixes_entry_still_quotes_the_retired_rate(self, readme_text):
        fixes = readme_text.split("\n## fixes")[1]
        assert "0.50 recall at best" in fixes

    def test_the_bullet_names_the_subclasss_own_zero(self, readme_prose):
        assert "bag-identical reorderings (0/2 at every threshold" in readme_prose

    def test_the_bullet_says_whose_the_050_is(self, readme_prose):
        assert "c02-5 and c07-5" in readme_prose

    def test_the_reading_above_it_still_states_the_tie(self, readme_prose):
        assert "no threshold fixes a score that is identical to the truth's" in (
            readme_prose
        )
