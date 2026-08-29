import pytest

from groundedness.scorers import (
    ContextBundle,
    content_tokens,
    extract_numbers,
    has_negation,
    negation_aware,
    numeric_gated,
    numeric_match,
    overlap,
    sentence_cosine,
)

CONTEXT = (
    "The session cache runs on Redis 7 with a memory ceiling of 4 GB. "
    "Entries expire after 45 minutes of inactivity. "
    "Delivery order is not guaranteed across consumers."
)


@pytest.fixture()
def bundle() -> ContextBundle:
    return ContextBundle(CONTEXT)


class TestContentTokens:
    def test_drops_stopwords_and_casefolds(self):
        assert content_tokens("The Cache IS warm") == ["cache", "warm"]

    def test_empty_text(self):
        assert content_tokens("") == []

    def test_stopwords_only(self):
        assert content_tokens("the of and is") == []


class TestExtractNumbers:
    def test_integers_and_decimals(self):
        assert extract_numbers("38 ms and p99 is 99.5%") == {38.0, 99.5}

    def test_digits_inside_an_identifier_are_not_numbers(self):
        # p99, ES256, s3 name a thing; the digits are not a quantity the
        # text asserts, and counting them dilutes the numeric evidence
        assert extract_numbers("the p99 is 610 ms") == {610.0}
        assert extract_numbers("ES256 signs the token") == set()
        assert extract_numbers("stored in s3 for 30 days") == {30.0}
        assert extract_numbers("see v1.2.3 for the change") == set()

    def test_thousands_separator_joins(self):
        assert extract_numbers("batches of 10,000 rows") == {10000.0}

    def test_int_and_float_forms_compare_equal(self):
        assert extract_numbers("2 GB") == extract_numbers("2.0 GB")

    def test_no_numbers(self):
        assert extract_numbers("no digits here") == set()


class TestHasNegation:
    def test_cues(self):
        assert has_negation("Rollbacks are not automatic")
        assert has_negation("ships without a script")
        assert has_negation("Two migrations never overlap")

    def test_non_cues(self):
        assert not has_negation("note the notation in the notebook")
        assert not has_negation("only one migration at a time")


class TestOverlap:
    def test_all_content_tokens_present(self, bundle):
        assert overlap("Entries expire after 45 minutes.", bundle) == 1.0

    def test_partial(self, bundle):
        # cache present, kubernetes absent, stopwords ignored
        assert overlap("the cache on kubernetes", bundle) == 0.5

    def test_empty_claim_scores_zero(self, bundle):
        assert overlap("", bundle) == 0.0

    def test_stopword_only_claim_scores_zero(self, bundle):
        assert overlap("it is of the and", bundle) == 0.0

    def test_duplicate_tokens_collapse(self, bundle):
        assert overlap("cache cache cache", bundle) == 1.0

    def test_unicode_casefold(self):
        b = ContextBundle("Café latency stayed flat. Nothing else changed.")
        assert overlap("café latency", b) == 1.0


class TestSentenceCosine:
    def test_exact_sentence_scores_one(self, bundle):
        score = sentence_cosine("Entries expire after 45 minutes of inactivity.", bundle)
        assert score == pytest.approx(1.0)

    def test_no_shared_vocabulary_scores_zero(self, bundle):
        assert sentence_cosine("zebra quantum flotilla", bundle) == 0.0

    def test_empty_context(self):
        empty = ContextBundle("")
        assert empty.best_sentence("anything") == (0.0, None)
        assert sentence_cosine("anything", empty) == 0.0

    def test_best_sentence_is_the_matching_one(self, bundle):
        _, best = bundle.best_sentence("Entries expire after 45 minutes")
        assert best == "Entries expire after 45 minutes of inactivity."

    def test_oversized_claim_stays_bounded(self, bundle):
        huge = "cache entries expire minutes " * 2500
        assert 0.0 <= sentence_cosine(huge, bundle) <= 1.0


class TestNumericMatch:
    def test_no_numbers_passes(self, bundle):
        assert numeric_match("Entries expire quickly.", bundle) == 1.0

    def test_wrong_number_fails(self, bundle):
        assert numeric_match("Entries expire after 90 minutes.", bundle) == 0.0

    def test_partial_match(self, bundle):
        # 45 is in the context, 90 is not
        assert numeric_match("45 minutes or 90 minutes", bundle) == 0.5


class TestNumericGated:
    def test_gate_caps_a_verbatim_claim_with_a_swapped_number(self, bundle):
        claim = "Entries expire after 44 minutes of inactivity."
        assert sentence_cosine(claim, bundle) > 0.5
        assert numeric_gated(claim, bundle) == 0.0

    def test_no_numbers_leaves_cosine_untouched(self, bundle):
        claim = "Entries expire after some minutes of inactivity."
        assert numeric_gated(claim, bundle) == sentence_cosine(claim, bundle)


class TestNegationAware:
    def test_added_negation_zeroes(self, bundle):
        claim = "Entries do not expire after 45 minutes of inactivity."
        assert negation_aware(claim, bundle) == 0.0

    def test_removed_negation_zeroes(self, bundle):
        claim = "Delivery order is guaranteed across consumers."
        assert negation_aware(claim, bundle) == 0.0

    def test_matching_negation_keeps_score(self, bundle):
        claim = "Delivery order is not guaranteed across consumers."
        assert negation_aware(claim, bundle) == pytest.approx(1.0)

    def test_matching_positive_keeps_score(self, bundle):
        claim = "Entries expire after 45 minutes of inactivity."
        assert negation_aware(claim, bundle) == pytest.approx(1.0)

    def test_empty_claim(self, bundle):
        assert negation_aware("", bundle) == 0.0


class TestContextBundle:
    def test_sentences_are_split(self, bundle):
        assert len(bundle.sentences) == 3

    def test_numbers_collected(self, bundle):
        assert bundle.numbers == {7.0, 4.0, 45.0}

    def test_duplicate_sentences_are_kept(self):
        b = ContextBundle("The cache is warm. The cache is warm.")
        assert len(b.sentences) == 2
        assert sentence_cosine("The cache is warm.", b) == pytest.approx(1.0)
