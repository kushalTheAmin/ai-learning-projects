import pytest

from retrieval_eval.synth import (
    COMMON_RANK_CUTOFF,
    DOC_LENGTH_RANGE,
    QUERY_TERM_COUNT,
    RARE_RANK_FLOOR,
    ZipfSampler,
    generate_corpus,
    generate_queries,
    term,
)
from retrieval_eval.tokenizer import tokenize


def test_corpus_is_deterministic_per_seed():
    assert generate_corpus(50, seed=1) == generate_corpus(50, seed=1)
    assert generate_corpus(50, seed=1) != generate_corpus(50, seed=2)


def test_corpus_shape():
    docs = generate_corpus(25, seed=4)
    assert len(docs) == 25
    assert list(docs)[0] == "d00000"
    for text in docs.values():
        tokens = text.split()
        assert DOC_LENGTH_RANGE[0] <= len(tokens) <= DOC_LENGTH_RANGE[1]
        # every term survives the project tokenizer unchanged, so the
        # generated corpus and the indexed corpus are the same corpus
        assert tokenize(text) == tokens


def test_empty_corpus_and_validation():
    assert generate_corpus(0, seed=1) == {}
    with pytest.raises(ValueError, match="n_docs"):
        generate_corpus(-1, seed=1)
    with pytest.raises(ValueError, match="n_queries"):
        generate_queries(-1, seed=1)
    with pytest.raises(ValueError, match="vocab_size"):
        ZipfSampler(vocab_size=0)


def test_zipf_head_is_heavier_than_tail():
    docs = generate_corpus(500, seed=8)
    def df(rank):
        return sum(term(rank) in text.split() for text in docs.values())
    assert df(1) > df(100) > df(5000)
    assert df(1) > 0.9 * len(docs)  # rank 1 behaves like a stopword


def test_queries_are_deterministic_and_distinct_terms():
    first = generate_queries(30, seed=2)
    assert first == generate_queries(30, seed=2)
    assert first != generate_queries(30, seed=3)
    for query in first:
        terms = query.split()
        assert len(terms) == QUERY_TERM_COUNT
        assert len(set(terms)) == QUERY_TERM_COUNT


def test_strata_respect_their_rank_windows():
    for query in generate_queries(30, seed=2, stratum="common-heavy"):
        assert all(int(word[1:]) <= COMMON_RANK_CUTOFF for word in query.split())
    for query in generate_queries(30, seed=2, stratum="rare-only"):
        assert all(int(word[1:]) >= RARE_RANK_FLOOR for word in query.split())
    with pytest.raises(ValueError, match="unknown stratum"):
        generate_queries(1, seed=2, stratum="nonsense")
