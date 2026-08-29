import pytest

from multihop.pipeline import interleave, iterative, single_shot
from multihop.reuse import BM25Index

# hop-shaped mini corpus: the question reaches "resp", only the bridge
# token "wobble" reaches "infra"; "noise" matches nothing relevant
CORPUS = {
    "resp": "wobble wobble owns the billing flow and every billing statement",
    "infra": "wobble stores records in the maindb cluster in the east region",
    "noise": "a cluster of unrelated words about regions and records and storage",
    # padding so the bridge token's document frequency (2 of n) still
    # carries idf weight, as it does in any corpus bigger than a toy
    "pad1": "completely different chatter about lunch menus and coffee machines",
    "pad2": "another page of chatter about parking assignments and desk moves",
}


@pytest.fixture()
def index() -> BM25Index:
    return BM25Index(CORPUS)


def test_interleave_round_robin() -> None:
    assert interleave(["a", "b"], ["c", "d"]) == ["a", "c", "b", "d"]


def test_interleave_dedups_keeping_first_position() -> None:
    assert interleave(["a", "b"], ["b", "a", "c"]) == ["a", "b", "c"]


def test_interleave_unequal_lengths() -> None:
    assert interleave(["a"], ["b", "c", "d"]) == ["a", "b", "c", "d"]
    assert interleave([], ["b"]) == ["b"]
    assert interleave([], []) == []


def test_single_shot_is_one_search(index: BM25Index) -> None:
    result = single_shot(index, "billing flow")
    assert result.search_calls == 1
    assert result.ranking[0] == "resp"
    assert result.hop2_ranking == []
    assert result.bridge_terms == []


def test_iterative_reaches_the_answer_doc(index: BM25Index) -> None:
    result = iterative(index, CORPUS, "which cluster holds the billing flow")
    assert result.search_calls == 2
    assert "wobble" in result.bridge_terms
    assert "infra" in result.ranking
    # single shot from the same question ranks infra behind noise or not at all
    baseline = single_shot(index, "which cluster holds the billing flow")
    assert baseline.ranking.index("resp") == 0


def test_iterative_falls_back_when_nothing_retrieved(index: BM25Index) -> None:
    result = iterative(index, CORPUS, "zzz qqq vvv")
    assert result.search_calls == 1
    assert result.ranking == []
    assert result.bridge_terms == []


def test_iterative_falls_back_when_no_bridge_terms(index: BM25Index) -> None:
    # question contains every term of the top doc: nothing novel to extract
    question = "wobble owns the billing flow and every billing statement"
    result = iterative(index, CORPUS, question)
    assert result.search_calls == 1
    assert result.ranking == result.hop1_ranking


def test_focus_mode_searches_bridge_only(index: BM25Index) -> None:
    focus = iterative(index, CORPUS, "which cluster holds the billing flow", mode="focus")
    append = iterative(index, CORPUS, "which cluster holds the billing flow", mode="append")
    # focus hop-2 scores nothing for question-only terms, so "noise"
    # (question vocabulary, no bridge token) cannot appear in its hop 2
    assert "noise" not in focus.hop2_ranking
    assert "noise" in append.hop2_ranking


def test_bridge_override_is_used_verbatim(index: BM25Index) -> None:
    result = iterative(index, CORPUS, "anything at all", bridge_override=["wobble"], mode="focus")
    assert result.bridge_terms == ["wobble"]
    assert result.hop2_ranking[0] in ("resp", "infra")


def test_empty_bridge_override_falls_back(index: BM25Index) -> None:
    result = iterative(index, CORPUS, "billing flow", bridge_override=[])
    assert result.search_calls == 1


def test_invalid_mode_raises(index: BM25Index) -> None:
    with pytest.raises(ValueError):
        iterative(index, CORPUS, "billing", mode="union")


def test_duplicate_question_terms_change_nothing(index: BM25Index) -> None:
    once = iterative(index, CORPUS, "which cluster holds the billing flow")
    twice = iterative(index, CORPUS, "which cluster holds the billing billing flow flow")
    assert once.ranking == twice.ranking


def test_oversized_question_stays_bounded(index: BM25Index) -> None:
    question = " ".join(["billing"] * 5000) + " flow cluster"
    result = iterative(index, CORPUS, question, top_k=2)
    assert len(result.hop1_ranking) <= 2
    assert len(result.ranking) <= 4
