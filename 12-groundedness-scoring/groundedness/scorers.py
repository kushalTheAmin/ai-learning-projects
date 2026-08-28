"""Groundedness scorers: claim + context -> score in [0, 1].

Higher means better supported by the context. Every scorer is a pure
function of the claim text and a ContextBundle; no model, no randomness.
A downstream detector flags a claim as unsupported when its score falls
below a threshold; picking that threshold is evaluate.py's job.
"""

import re
from collections.abc import Callable

from .reuse import TfidfIndex, split_sentences, tokenize

# function words carrying no claim content. negation words are deliberately
# NOT in here: whether keeping "not" as a content token lets overlap see a
# negation flip is one of the things this project measures.
STOPWORDS = frozenset(
    """a an the and or but if that this these those is are was were be been
    being it its of in on at to for from with by as so do does did has have
    had having can could will would should when while than then there their
    they them we you which what who whose how where why also such""".split()
)

NEGATION_CUES = frozenset(
    {"not", "no", "never", "cannot", "without", "nor", "none"}
)

_NUMBER_RE = re.compile(r"\d+(?:\.\d+)?")
_THOUSANDS_COMMA_RE = re.compile(r"(?<=\d),(?=\d)")


def content_tokens(text: str) -> list[str]:
    return [token for token in tokenize(text) if token not in STOPWORDS]


def extract_numbers(text: str) -> set[float]:
    """Numeric literals in the text, as floats, so 2 and 2.0 compare equal.

    Digits only: spelled-out numbers ("two week") are invisible here.
    Thousands separators are joined first so 10,000 reads as one number.
    """
    joined = _THOUSANDS_COMMA_RE.sub("", text)
    return {float(match) for match in _NUMBER_RE.findall(joined)}


def has_negation(text: str) -> bool:
    return any(token in NEGATION_CUES for token in tokenize(text))


class ContextBundle:
    """A context prepared for scoring: sentences, per-sentence tf-idf
    index fitted on this context alone, content-token set, number set."""

    def __init__(self, text: str):
        self.text = text
        self.sentences = [s.text for s in split_sentences(text)]
        self._by_id = {f"s{i}": s for i, s in enumerate(self.sentences)}
        self.index = TfidfIndex(self._by_id) if self._by_id else None
        self.content = set(content_tokens(text))
        self.numbers = extract_numbers(text)

    def best_sentence(self, claim: str) -> tuple[float, str | None]:
        """Cosine of the claim against its closest context sentence."""
        if self.index is None:
            return 0.0, None
        hits = self.index.search(claim, top_k=1)
        if not hits:
            return 0.0, None
        sentence_id, score = hits[0]
        # cosine over nonnegative vectors lives in [0, 1]; float rounding
        # can overshoot 1 by an epsilon on a self-match
        return min(score, 1.0), self._by_id[sentence_id]


def overlap(claim: str, bundle: ContextBundle) -> float:
    """Precision of the claim's unique content tokens against the whole
    context. A claim with no content tokens has no checkable content and
    scores 0."""
    claim_tokens = set(content_tokens(claim))
    if not claim_tokens:
        return 0.0
    return len(claim_tokens & bundle.content) / len(claim_tokens)


def sentence_cosine(claim: str, bundle: ContextBundle) -> float:
    """Max tf-idf cosine between the claim and any single context
    sentence. Support usually lives in one sentence; scoring against the
    whole context at once would let unrelated sentences dilute the idf."""
    score, _ = bundle.best_sentence(claim)
    return score


def numeric_match(claim: str, bundle: ContextBundle) -> float:
    """Fraction of the claim's numbers that appear anywhere in the
    context. A claim with no numbers offers no numeric evidence either
    way and passes with 1."""
    claim_numbers = extract_numbers(claim)
    if not claim_numbers:
        return 1.0
    return len(claim_numbers & bundle.numbers) / len(claim_numbers)


def numeric_gated(claim: str, bundle: ContextBundle) -> float:
    """Sentence cosine, capped by numeric consistency: a claim citing a
    number the context never states cannot be grounded, however well its
    words align."""
    return min(sentence_cosine(claim, bundle), numeric_match(claim, bundle))


def negation_aware(claim: str, bundle: ContextBundle) -> float:
    """numeric_gated, zeroed when the claim and its best-matching
    sentence disagree on negation. Deliberately blunt: any parity
    mismatch scores 0, so a supported claim that legitimately restates a
    positive sentence in negative form pays full price. That cost is
    measured, not hidden."""
    score, best = bundle.best_sentence(claim)
    if best is not None and has_negation(claim) != has_negation(best):
        return 0.0
    return min(score, numeric_match(claim, bundle))


Scorer = Callable[[str, ContextBundle], float]

METHODS: dict[str, Scorer] = {
    "overlap": overlap,
    "sentence_cosine": sentence_cosine,
    "numeric_gated": numeric_gated,
    "negation_aware": negation_aware,
}
