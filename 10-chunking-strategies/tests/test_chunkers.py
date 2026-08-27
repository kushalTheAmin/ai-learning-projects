import pytest

from chunking.chunkers import fixed_chunks, sentence_chunks, word_count


def spans_are_valid(chunks, text):
    return all(text[c.start : c.end] == c.text for c in chunks)


class TestFixedChunks:
    def test_exact_windows(self):
        text = "one two three four five six seven"
        chunks = fixed_chunks("d", text, size=3)
        assert [c.text for c in chunks] == ["one two three", "four five six", "seven"]

    def test_spans_map_back(self):
        text = "alpha   beta\n\ngamma delta epsilon"
        chunks = fixed_chunks("d", text, size=2)
        assert spans_are_valid(chunks, text)
        assert [c.text for c in chunks] == ["alpha   beta", "gamma delta", "epsilon"]

    def test_every_word_covered_exactly_once_without_overlap(self):
        text = " ".join(f"w{i}" for i in range(203))
        chunks = fixed_chunks("d", text, size=40)
        reassembled = " ".join(c.text for c in chunks)
        assert reassembled.split() == text.split()

    def test_overlap_stride(self):
        text = "a b c d e f g h"
        chunks = fixed_chunks("d", text, size=4, overlap=2)
        assert [c.text for c in chunks] == ["a b c d", "c d e f", "e f g h"]

    def test_overlap_stops_after_last_word(self):
        text = "a b c d e"
        chunks = fixed_chunks("d", text, size=4, overlap=2)
        assert [c.text for c in chunks] == ["a b c d", "c d e"]

    def test_chunk_ids_are_doc_scoped_and_sequential(self):
        chunks = fixed_chunks("mydoc", "a b c d", size=2)
        assert [c.id for c in chunks] == ["mydoc#0", "mydoc#1"]

    def test_single_word(self):
        chunks = fixed_chunks("d", "hello", size=40)
        assert len(chunks) == 1
        assert chunks[0].text == "hello"

    def test_empty_text(self):
        assert fixed_chunks("d", "", size=10) == []
        assert fixed_chunks("d", "   \n ", size=10) == []

    def test_oversized_input_smaller_than_window(self):
        text = "just three words"
        chunks = fixed_chunks("d", text, size=100)
        assert len(chunks) == 1
        assert chunks[0].text == text

    def test_unicode_words(self):
        text = "café naïve 東京 москва"
        chunks = fixed_chunks("d", text, size=2)
        assert [c.text for c in chunks] == ["café naïve", "東京 москва"]

    def test_invalid_size(self):
        with pytest.raises(ValueError):
            fixed_chunks("d", "a b", size=0)

    def test_invalid_overlap(self):
        with pytest.raises(ValueError):
            fixed_chunks("d", "a b", size=4, overlap=4)
        with pytest.raises(ValueError):
            fixed_chunks("d", "a b", size=4, overlap=-1)


class TestSentenceChunks:
    def test_packs_up_to_budget(self):
        text = "One two three. Four five six. Seven eight nine."
        chunks = sentence_chunks("d", text, budget=6)
        assert [c.text for c in chunks] == [
            "One two three. Four five six.",
            "Seven eight nine.",
        ]

    def test_never_splits_a_sentence(self):
        text = "Aa bb cc dd. Ee ff gg hh. Ii jj kk ll."
        for budget in (1, 2, 4, 5, 8, 100):
            chunks = sentence_chunks("d", text, budget=budget)
            for sentence in ("Aa bb cc dd.", "Ee ff gg hh.", "Ii jj kk ll."):
                assert any(sentence in c.text for c in chunks), (budget, sentence)

    def test_oversized_sentence_becomes_own_chunk(self):
        text = "Tiny. This single sentence has considerably more words than the budget allows. End."
        chunks = sentence_chunks("d", text, budget=3)
        texts = [c.text for c in chunks]
        assert "This single sentence has considerably more words than the budget allows." in texts

    def test_budget_one_yields_one_sentence_per_chunk(self):
        text = "First one. Second one. Third one."
        chunks = sentence_chunks("d", text, budget=1)
        assert len(chunks) == 3

    def test_spans_map_back(self):
        text = "The cat sat.   The dog barked. The bird flew away quickly."
        chunks = sentence_chunks("d", text, budget=6)
        assert spans_are_valid(chunks, text)

    def test_empty_text(self):
        assert sentence_chunks("d", "", budget=10) == []

    def test_invalid_budget(self):
        with pytest.raises(ValueError):
            sentence_chunks("d", "A b.", budget=0)


def test_word_count():
    assert word_count("") == 0
    assert word_count("one") == 1
    assert word_count("  spaced   out\nwords ") == 3
