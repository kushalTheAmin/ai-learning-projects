import numpy as np
import pytest

from reranking.reuse import DenseLSA, tokenize
from reranking.term_space import TermSpace


@pytest.fixture(scope="module")
def space(evaluator):
    return evaluator.space


def test_unfitted_lsa_rejected():
    with pytest.raises(ValueError, match="fitted"):
        TermSpace(DenseLSA(), ["d1"], ["some text"])


def test_mismatched_ids_and_texts_rejected(evaluator):
    with pytest.raises(ValueError, match="doc ids"):
        TermSpace(evaluator.lsa, ["d1", "d2"], ["only one text"])


def test_duplicate_doc_ids_rejected(evaluator):
    with pytest.raises(ValueError, match="duplicate doc id"):
        TermSpace(evaluator.lsa, ["d1", "d1"], ["text a", "text b"])


def test_term_vectors_are_unit_rows(space):
    norms = np.linalg.norm(space.term_vectors, axis=1)
    assert np.allclose(norms, 1.0, atol=1e-9)


def test_term_vector_is_what_lsa_gives_a_one_term_document(evaluator, space):
    """The claim in the module docstring: a single-term document maps under
    the fitted pipeline to (a positive multiple of) that term's row here."""
    lsa = evaluator.lsa
    for word in ("delete", "branch", "gateway"):
        term = tokenize(word)[0]
        row = space.term_vectors[space.vocab[term]]
        transformed = lsa._svd.transform(lsa._vectorizer.transform([word]))[0]
        transformed = transformed / np.linalg.norm(transformed)
        assert np.allclose(transformed, row, atol=1e-9), word


def test_term_indices_dedupe_and_preserve_first_seen_order(space):
    once = space.term_indices("delete branch")
    doubled = space.term_indices("delete branch delete branch")
    assert np.array_equal(once, doubled)
    assert len(once) == 2
    assert once[0] == space.vocab[tokenize("delete")[0]]


def test_term_indices_drop_out_of_vocabulary_terms(space):
    # "GIL" never appears in the corpus, so the space has no row for it
    assert len(space.term_indices("GIL")) == 0
    mixed = space.term_indices("GIL delete")
    assert len(mixed) == 1


def test_term_indices_on_empty_and_unicode_input(space):
    assert len(space.term_indices("")) == 0
    assert len(space.term_indices("   \n\t")) == 0
    # non-ascii tokens are outside the tokenizer's alphabet and are dropped
    with_noise = space.term_indices("café 削除 🚀 delete")
    assert len(with_noise) >= 1
    assert space.vocab[tokenize("delete")[0]] in with_noise


def test_profiles_match_term_indices_of_the_text(space, docs):
    sample = docs[0]
    profile = space.profiles[sample.doc_id]
    assert np.array_equal(profile.term_indices, space.term_indices(sample.text))
    assert len(space.profiles) == len(docs)


def test_synonyms_sit_closer_than_unrelated_terms(space):
    def cos(word_a, word_b):
        va = space.term_vectors[space.vocab[tokenize(word_a)[0]]]
        vb = space.term_vectors[space.vocab[tokenize(word_b)[0]]]
        return float(va @ vb)

    # delete/remove co-occur across the corpus; delete/gateway do not
    assert cos("delete", "remove") > 0.4
    assert cos("delete", "gateway") < 0.1
    assert cos("delete", "remove") > cos("delete", "gateway")
