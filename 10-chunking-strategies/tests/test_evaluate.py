import pytest

from chunking.chunkers import fixed_chunks, sentence_chunks
from chunking.corpus import Doc, Query
from chunking.evaluate import evaluate_config

DOCS = [
    Doc(
        id="widgets",
        title="Widgets",
        text=(
            "The widget factory opens at dawn. Widgets are assembled from brass and steel. "
            "The quality gate rejects any widget heavier than 40 grams. "
            "Rejected widgets are melted down the same day. The factory closes at dusk."
        ),
    ),
    Doc(
        id="gadgets",
        title="Gadgets",
        text=(
            "Gadgets ship from a different plant entirely. Gadget batteries last 12 hours. "
            "Every gadget passes a drop test from two meters. Returns go to the refurbishment line."
        ),
    ),
]

QUERIES = [
    Query(
        id="g1",
        query="widget weight quality gate grams",
        doc_id="widgets",
        answer="The quality gate rejects any widget heavier than 40 grams.",
        category="keyword",
    ),
    Query(
        id="g2",
        query="gadget battery hours",
        doc_id="gadgets",
        answer="Gadget batteries last 12 hours.",
        category="keyword",
    ),
]


def sentence_chunker(budget):
    return lambda d, t: sentence_chunks(d, t, budget=budget)


def test_sentence_chunking_finds_both_answers():
    result = evaluate_config("s", DOCS, QUERIES, sentence_chunker(12))
    assert result.split_rate == 0.0
    assert result.hit_rate_at_k == 1.0
    assert result.mrr_at_k > 0.0
    for r in result.per_query:
        assert r.best_coverage == 1.0
        assert all("#" in cid for cid in r.relevant_chunk_ids)


def test_relevance_is_exact_containment():
    result = evaluate_config("s", DOCS, QUERIES, sentence_chunker(100))
    # budget 100 packs each doc into one chunk, so the relevant chunk is
    # simply the answer's home doc
    for r in result.per_query:
        assert r.relevant_chunk_ids == [f"{r.query.doc_id}#0"]


def test_split_answer_scores_zero_but_keeps_coverage():
    # 4-word windows over the widgets doc cut the 10-word answer sentence
    # across boundaries no matter what, so no chunk contains it fully
    doc = DOCS[0]
    result = evaluate_config("f", [doc], [QUERIES[0]], lambda d, t: fixed_chunks(d, t, size=4))
    r = result.per_query[0]
    assert r.answer_split
    assert r.relevant_chunk_ids == []
    assert r.rr_at_k == 0.0
    assert not r.hit_at_1 and not r.hit_at_k
    assert 0.0 < r.best_coverage < 1.0


def test_best_coverage_is_the_max_over_chunks():
    text = "aaa bbb ccc ddd eee fff"
    doc = Doc(id="d", title="D", text=text)
    query = Query(id="q", query="ccc ddd", doc_id="d", answer="ccc ddd", category="keyword")
    # size 4: chunks are "aaa bbb ccc ddd" and "eee fff" — first contains it
    result = evaluate_config("f", [doc], [query], lambda d, t: fixed_chunks(d, t, size=4))
    assert result.per_query[0].best_coverage == 1.0
    # size 3: "aaa bbb ccc" / "ddd eee fff" — best chunk holds "ccc" =
    # 3 of the answer's 7 characters
    result = evaluate_config("f", [doc], [query], lambda d, t: fixed_chunks(d, t, size=3))
    assert result.per_query[0].best_coverage == pytest.approx(3 / 7)


def test_overlap_makes_split_answer_whole():
    # answer sits at words 6..9; size-4 windows start at 0, 4, 8 and cut
    # it, while overlap 2 adds a window starting at word 6 that holds it
    doc = Doc(id="d", title="D", text=" ".join(f"w{i}" for i in range(20)))
    query = Query(id="q", query="w6 w7", doc_id="d", answer="w6 w7 w8 w9", category="keyword")
    split = evaluate_config("f", [doc], [query], lambda d, t: fixed_chunks(d, t, size=4))
    whole = evaluate_config(
        "f", [doc], [query], lambda d, t: fixed_chunks(d, t, size=4, overlap=2)
    )
    assert split.per_query[0].answer_split
    assert not whole.per_query[0].answer_split


def test_index_words_counts_duplication():
    plain = evaluate_config("a", DOCS, QUERIES, lambda d, t: fixed_chunks(d, t, size=8))
    overlapped = evaluate_config(
        "b", DOCS, QUERIES, lambda d, t: fixed_chunks(d, t, size=8, overlap=4)
    )
    assert overlapped.index_words > plain.index_words


def test_context_words_measure_top_chunks():
    result = evaluate_config("s", DOCS, QUERIES, sentence_chunker(12))
    for r in result.per_query:
        assert r.context_words > 0


def test_empty_chunker_output_raises():
    with pytest.raises(ValueError, match="produced no chunks"):
        evaluate_config("x", [Doc(id="e", title="E", text="")], QUERIES, sentence_chunker(10))
