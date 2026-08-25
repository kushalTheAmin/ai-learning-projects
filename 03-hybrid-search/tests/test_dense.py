import numpy as np
import pytest

from hybrid_search.dense import DenseLSA

# small corpus with deliberate co-occurrence: "terminate" and "kill" appear
# together in doc 0, so a query using one should surface docs using the other
CORPUS = [
    "kill or terminate a stuck process with a signal",
    "terminate the running process cleanly before shutdown",
    "bake bread with flour yeast and water",
    "knead the bread dough and let it rise",
]


def test_empty_corpus_raises():
    with pytest.raises(ValueError):
        DenseLSA().fit([])


def test_scores_before_fit_raises():
    with pytest.raises(RuntimeError):
        DenseLSA().scores("anything")


def test_scores_are_cosine_bounded():
    dense = DenseLSA().fit(CORPUS)
    scores = dense.scores("kill the process")
    assert np.all(scores <= 1.0 + 1e-9) and np.all(scores >= -1.0 - 1e-9)


def test_topically_related_docs_beat_unrelated():
    dense = DenseLSA().fit(CORPUS)
    scores = dense.scores("kill a process")
    assert min(scores[0], scores[1]) > max(scores[2], scores[3])


def test_cooccurrence_bridges_synonyms():
    # "kill" never appears in doc 1, but co-occurs with "terminate" in doc 0
    dense = DenseLSA().fit(CORPUS)
    ranking = dense.rank("kill")
    assert set(ranking[:2]) == {0, 1}


def test_oov_query_scores_zero_everywhere():
    dense = DenseLSA().fit(CORPUS)
    assert np.all(dense.scores("xylophone zebra") == 0.0)


def test_empty_query_scores_zero_everywhere():
    dense = DenseLSA().fit(CORPUS)
    assert np.all(dense.scores("") == 0.0)


def test_deterministic_across_fits():
    a = DenseLSA().fit(CORPUS).scores("terminate the process")
    b = DenseLSA().fit(CORPUS).scores("terminate the process")
    assert np.array_equal(a, b)


def test_single_document_corpus():
    dense = DenseLSA().fit(["just one document about caching"])
    assert dense.scores("caching")[0] == pytest.approx(1.0)


def test_duplicate_documents_score_identically():
    dense = DenseLSA().fit(["same text here", "same text here", "other topic entirely"])
    scores = dense.scores("same text")
    assert scores[0] == pytest.approx(scores[1])


def test_component_cap_respects_corpus_size():
    # 3 docs cannot support 64 components; must clamp instead of crashing
    dense = DenseLSA(n_components=64).fit(CORPUS[:3])
    assert dense.rank("bread").shape == (3,)
