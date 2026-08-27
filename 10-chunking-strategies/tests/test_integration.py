"""End-to-end assertions over the committed corpus and queries.

These pin the findings the README quotes: exact split counts and hit
rates for the headline configurations. If the data or the chunkers
change behavior, these fail loudly rather than letting the README drift.
"""

from pathlib import Path

from chunking.chunkers import fixed_chunks, sentence_chunks
from chunking.corpus import load_docs, load_queries, validate
from chunking.evaluate import evaluate_config

DATA = Path(__file__).parent.parent / "data"


def load():
    docs = load_docs(DATA / "corpus.jsonl")
    queries = load_queries(DATA / "queries.jsonl")
    validate(docs, queries)
    return docs, queries


def test_sentence_chunking_never_splits_an_answer():
    docs, queries = load()
    for budget in (40, 80, 160):
        result = evaluate_config(
            f"s{budget}", docs, queries, lambda d, t, b=budget: sentence_chunks(d, t, budget=b)
        )
        assert result.split_rate == 0.0, budget


def test_fixed_chunking_splits_answers_and_smaller_splits_more():
    docs, queries = load()
    splits = {}
    for size in (40, 80, 160):
        result = evaluate_config(
            f"f{size}", docs, queries, lambda d, t, s=size: fixed_chunks(d, t, size=s)
        )
        splits[size] = sum(r.answer_split for r in result.per_query)
    assert splits[40] > splits[80] > splits[160] > 0
    assert splits[80] == 17  # pinned: the number the README quotes


def test_overlap_recovers_most_splits_at_index_cost():
    docs, queries = load()
    base = evaluate_config("f80", docs, queries, lambda d, t: fixed_chunks(d, t, size=80))
    ov = evaluate_config(
        "ov20", docs, queries, lambda d, t: fixed_chunks(d, t, size=80, overlap=20)
    )
    base_split = {r.query.id for r in base.per_query if r.answer_split}
    ov_split = {r.query.id for r in ov.per_query if r.answer_split}
    assert len(ov_split) < len(base_split)
    assert ov.index_words > base.index_words
    # overlap does NOT only add windows: the stride shrinks from 80 to 60,
    # every boundary moves, and one answer that fixed-80 kept whole gets
    # newly cut. pinned because the README makes a point of it.
    assert len(base_split - ov_split) == 15
    assert len(ov_split - base_split) == 1


def test_sentence_beats_plain_fixed_at_comparable_size():
    docs, queries = load()
    fixed = evaluate_config("f80", docs, queries, lambda d, t: fixed_chunks(d, t, size=80))
    sent = evaluate_config("s80", docs, queries, lambda d, t: sentence_chunks(d, t, budget=80))
    assert sent.hit_rate_at_k > fixed.hit_rate_at_k
    assert sent.mrr_at_k > fixed.mrr_at_k
    # same corpus indexed once per strategy: word totals match because
    # neither duplicates text
    assert sent.index_words == fixed.index_words


def test_headline_numbers():
    docs, queries = load()
    sent = evaluate_config("s80", docs, queries, lambda d, t: sentence_chunks(d, t, budget=80))
    assert sent.hit_rate_at_k == 0.85
    assert round(sent.mrr_at_k, 3) == 0.698


def test_split_answers_keep_partial_coverage():
    docs, queries = load()
    result = evaluate_config("f80", docs, queries, lambda d, t: fixed_chunks(d, t, size=80))
    split = [r for r in result.per_query if r.answer_split]
    assert split
    for r in split:
        assert 0.0 < r.best_coverage < 1.0


def test_deterministic_across_runs():
    docs, queries = load()
    a = evaluate_config("s80", docs, queries, lambda d, t: sentence_chunks(d, t, budget=80))
    b = evaluate_config("s80", docs, queries, lambda d, t: sentence_chunks(d, t, budget=80))
    assert a.per_query == b.per_query
    assert a.index_words == b.index_words


def test_ranked_ids_are_real_chunks():
    docs, queries = load()
    result = evaluate_config("f40", docs, queries, lambda d, t: fixed_chunks(d, t, size=40))
    valid_docs = {d.id for d in docs}
    for r in result.per_query:
        for chunk_id in r.ranked_chunk_ids:
            doc_id, _, index = chunk_id.partition("#")
            assert doc_id in valid_docs
            assert index.isdigit()
