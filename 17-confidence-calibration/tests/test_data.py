import numpy as np
import pytest

from calibration.data import (
    DRIFT_FILLER,
    FILLER,
    LABELS,
    class_bank,
    generate_tickets,
    labels_array,
)
from calibration.features import build_vocabulary, vectorize
from calibration.reuse import tokenize


def test_seeded_generation_is_reproducible():
    a = generate_tickets(50, seed=9)
    b = generate_tickets(50, seed=9)
    assert a == b


def test_different_seeds_differ():
    assert generate_tickets(50, seed=1) != generate_tickets(50, seed=2)


def test_labels_are_valid_and_text_nonempty():
    tickets = generate_tickets(200, seed=3)
    for t in tickets:
        assert 0 <= t.label < len(LABELS)
        assert t.text.strip()
    labels = labels_array(tickets)
    assert labels.shape == (200,)
    assert set(np.unique(labels)) <= set(range(len(LABELS)))


def test_zero_ambiguity_uses_only_own_and_filler_phrases():
    tickets = generate_tickets(80, seed=4, ambiguity=0.0)
    allowed_by_label = {
        i: set(class_bank(name)) | set(FILLER) for i, name in enumerate(LABELS)
    }
    for t in tickets:
        phrases = [p for p in t.text.rstrip(".").split(". ") if p]
        assert phrases, t.text
        assert set(phrases) <= allowed_by_label[t.label]


def test_class_banks_are_pairwise_disjoint():
    for i, a in enumerate(LABELS):
        for b in LABELS[i + 1 :]:
            assert not set(class_bank(a)) & set(class_bank(b))
    assert not set(FILLER) & set(DRIFT_FILLER)


def test_drift_filler_is_unseen_by_training_vocabulary():
    train = generate_tickets(300, seed=5)
    vocabulary = build_vocabulary([t.text for t in train])
    drift_tokens = set()
    for phrase in DRIFT_FILLER:
        drift_tokens.update(tokenize(phrase))
    novel = drift_tokens - set(vocabulary)
    # drift filler must actually inject vocabulary the model never saw
    assert len(novel) >= 10


def test_invalid_arguments_rejected():
    with pytest.raises(ValueError):
        generate_tickets(-1, seed=0)
    with pytest.raises(ValueError):
        generate_tickets(1, seed=0, ambiguity=1.5)
    with pytest.raises(ValueError):
        generate_tickets(1, seed=0, ambiguity=0.7, filler_rate=0.7)
    with pytest.raises(ValueError):
        generate_tickets(1, seed=0, phrases_per_ticket=0)


def test_zero_tickets_is_fine():
    assert generate_tickets(0, seed=0) == []


def test_unicode_filler_survives_tokenization_and_vectorization():
    # FILLER contains "naïve"; 02's tokenizer keeps the unicode run whole
    assert "naïve" in " ".join(FILLER)
    assert tokenize("a naïve workaround") == ["a", "naïve", "workaround"]
    vocabulary = build_vocabulary(["a naïve workaround"])
    assert "naïve" in vocabulary
    row = vectorize(["naïve naïve"], vocabulary)
    assert row[0, vocabulary["naïve"]] == 2.0


def test_vectorize_drops_unknown_tokens():
    vocabulary = build_vocabulary(["alpha beta"])
    row = vectorize(["alpha gamma gamma"], vocabulary)
    assert row.sum() == 1.0


def test_vectorize_empty_vocabulary_rejected():
    with pytest.raises(ValueError):
        vectorize(["text"], {})


def test_vectorize_counts_duplicates():
    vocabulary = build_vocabulary(["retry retry loop"])
    row = vectorize(["retry retry retry"], vocabulary)
    assert row[0, vocabulary["retry"]] == 3.0
