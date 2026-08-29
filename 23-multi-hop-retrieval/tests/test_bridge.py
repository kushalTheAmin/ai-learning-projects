import pytest

from multihop.bridge import extract_bridge_terms
from multihop.reuse import BM25Index

CORPUS = {
    "a": "zephyr zephyr zephyr handles the billing flow for the whole site",
    "b": "zephyr writes to the maindb cluster in the east region",
    "c": "the billing flow is audited monthly and the audit is thorough",
    "d": "clusters and regions and flows, a glossary of common common words",
}


@pytest.fixture()
def index() -> BM25Index:
    return BM25Index(CORPUS)


def test_distinctive_novel_term_wins(index: BM25Index) -> None:
    terms = extract_bridge_terms(CORPUS["a"], "which cluster backs the billing flow", index)
    assert terms[0] == "zephyr"


def test_question_terms_are_excluded(index: BM25Index) -> None:
    terms = extract_bridge_terms(CORPUS["a"], "zephyr billing flow site whole handles the for", index)
    assert "zephyr" not in terms
    assert "billing" not in terms


def test_max_terms_caps_output(index: BM25Index) -> None:
    assert len(extract_bridge_terms(CORPUS["a"], "unrelated", index, max_terms=2)) == 2
    assert len(extract_bridge_terms(CORPUS["a"], "unrelated", index, max_terms=1)) == 1


def test_max_terms_below_one_raises(index: BM25Index) -> None:
    with pytest.raises(ValueError):
        extract_bridge_terms(CORPUS["a"], "q", index, max_terms=0)


def test_empty_doc_yields_nothing(index: BM25Index) -> None:
    assert extract_bridge_terms("", "which cluster", index) == []


def test_doc_of_only_question_terms_yields_nothing(index: BM25Index) -> None:
    assert extract_bridge_terms("billing flow billing", "the billing flow", index) == []


def test_out_of_corpus_terms_score_zero_and_drop(index: BM25Index) -> None:
    terms = extract_bridge_terms("xylophone quartet xylophone", "which cluster", index)
    assert terms == []


def test_tie_breaks_alphabetically() -> None:
    # two docs, two novel terms with identical tf and df: score ties exactly
    index = BM25Index({"a": "kiwi mango", "b": "kiwi mango"})
    terms = extract_bridge_terms("kiwi mango", "what fruit", index)
    assert terms == ["kiwi", "mango"]


def test_unicode_doc_and_question(index: BM25Index) -> None:
    unicode_index = BM25Index({**CORPUS, "u": "café naïve café über service détails"})
    terms = extract_bridge_terms("café naïve café über service détails", "which détails", unicode_index)
    assert terms[0] == "café"
    assert "détails" not in terms


def test_repeated_term_beats_rarer_single_occurrence(index: BM25Index) -> None:
    # tf * idf: three zephyrs in doc a outweigh any single-occurrence term
    terms = extract_bridge_terms(CORPUS["a"], "the whole", index, max_terms=1)
    assert terms == ["zephyr"]
