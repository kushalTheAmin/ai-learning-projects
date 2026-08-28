from pathlib import Path

import pytest

from groundedness.data import (
    CATEGORIES,
    SUPPORTED_CATEGORIES,
    UNSUPPORTED_CATEGORIES,
    Claim,
    Context,
    load_contexts,
    validate,
)

DATA = Path(__file__).parent.parent / "data" / "contexts.jsonl"


def make_claim(**overrides) -> Claim:
    fields = {
        "id": "c-1",
        "text": "The cache is warm.",
        "supported": True,
        "category": "verbatim",
    }
    fields.update(overrides)
    return Claim(**fields)


def make_context(claims: tuple[Claim, ...], context_id: str = "ctx-1") -> Context:
    return Context(id=context_id, text="The cache is warm.", claims=claims)


class TestCommittedDataset:
    def test_loads_and_validates(self):
        contexts = load_contexts(DATA)
        assert len(contexts) == 10
        claims = [claim for context in contexts for claim in context.claims]
        assert len(claims) == 60

    def test_class_balance(self):
        contexts = load_contexts(DATA)
        claims = [claim for context in contexts for claim in context.claims]
        assert sum(claim.supported for claim in claims) == 25
        assert sum(not claim.supported for claim in claims) == 35

    def test_every_category_is_populated(self):
        contexts = load_contexts(DATA)
        seen = {claim.category for context in contexts for claim in context.claims}
        assert seen == CATEGORIES

    def test_category_counts(self):
        contexts = load_contexts(DATA)
        counts: dict[str, int] = {}
        for context in contexts:
            for claim in context.claims:
                counts[claim.category] = counts.get(claim.category, 0) + 1
        assert counts == {
            "verbatim": 7,
            "paraphrase": 9,
            "synthesis": 5,
            "negated_paraphrase": 4,
            "entity_swap": 7,
            "number_swap": 7,
            "negation_flip": 7,
            "antonym_flip": 4,
            "fabricated": 6,
            "outside_knowledge": 4,
        }


class TestValidation:
    def test_supported_and_unsupported_categories_partition(self):
        assert SUPPORTED_CATEGORIES | UNSUPPORTED_CATEGORIES == CATEGORIES
        assert not SUPPORTED_CATEGORIES & UNSUPPORTED_CATEGORIES

    def test_empty_dataset_rejected(self):
        with pytest.raises(ValueError, match="empty"):
            validate([])

    def test_duplicate_context_id_rejected(self):
        context = make_context((make_claim(),))
        other = make_context((make_claim(id="c-2"),))
        with pytest.raises(ValueError, match="duplicate context id"):
            validate([context, other])

    def test_duplicate_claim_id_rejected(self):
        context = make_context((make_claim(), make_claim()))
        with pytest.raises(ValueError, match="duplicate claim id"):
            validate([context])

    def test_unknown_category_rejected(self):
        context = make_context((make_claim(category="vibes"),))
        with pytest.raises(ValueError, match="unknown category"):
            validate([context])

    def test_category_support_mismatch_rejected(self):
        context = make_context((make_claim(category="fabricated", supported=True),))
        with pytest.raises(ValueError, match="implies supported=False"):
            validate([context])

    def test_empty_context_text_rejected(self):
        context = Context(id="ctx-1", text="   ", claims=(make_claim(),))
        with pytest.raises(ValueError, match="empty text"):
            validate([context])

    def test_empty_claim_text_rejected(self):
        context = make_context((make_claim(text=" "),))
        with pytest.raises(ValueError, match="empty text"):
            validate([context])

    def test_context_without_claims_rejected(self):
        context = make_context(())
        with pytest.raises(ValueError, match="no claims"):
            validate([context])
