import pytest

from baselines import UNK, CharTokenizer, WordTokenizer, word_split


class TestWordSplit:
    @pytest.mark.parametrize("text", ["", "a", "a b", "a  b", " a ", "\n\ta\n"])
    def test_pieces_rejoin_exactly(self, text):
        assert "".join(word_split(text)) == text

    def test_words_and_whitespace_alternate(self):
        assert word_split("the cat") == ["the", " ", "cat"]


class TestWordTokenizer:
    def test_vocab_is_top_types_by_frequency(self):
        # Counts: " " x5, "a" x3, "b" x2, "c" x1.
        tok = WordTokenizer.train("a a a b b c", 3)
        assert tok.vocab == [UNK, " ", "a"]

    def test_frequency_ties_break_alphabetically(self):
        tok = WordTokenizer.train("b b a a", 4)
        assert tok.vocab == [UNK, " ", "a", "b"]

    def test_unseen_word_becomes_unk(self):
        tok = WordTokenizer.train("a a a b b c", 4)
        assert tok.decode(tok.encode("a z")) == f"a {UNK}"

    def test_seen_text_round_trips(self):
        tok = WordTokenizer.train("the cat sat on the mat", 20)
        text = "the mat sat on the cat"
        assert tok.decode(tok.encode(text)) == text

    def test_oov_stats(self):
        tok = WordTokenizer.train("a a a b b c", 4)
        # "a z b q" splits into 7 runs; z and q are OOV.
        assert tok.oov_stats("a z b q") == (2, 7)
        assert tok.oov_stats("") == (0, 0)

    def test_vocab_one_is_all_unk(self):
        tok = WordTokenizer.train("a b c", 1)
        assert tok.vocab == [UNK]
        assert tok.oov_stats("a b") == (3, 3)

    def test_empty_text(self):
        tok = WordTokenizer.train("a b", 10)
        assert tok.encode("") == []
        assert tok.decode([]) == ""

    def test_vocab_must_contain_unk(self):
        with pytest.raises(ValueError):
            WordTokenizer(["a", "b"])
        with pytest.raises(ValueError):
            WordTokenizer.train("a b", 0)


class TestCharTokenizer:
    def test_seen_text_round_trips(self):
        tok = CharTokenizer.train("abc abc")
        assert tok.decode(tok.encode("cab bac")) == "cab bac"

    def test_unseen_char_becomes_unk(self):
        tok = CharTokenizer.train("abc")
        ids = tok.encode("abd")
        assert ids[2] == 0
        assert tok.decode(ids) == f"ab{UNK}"

    def test_unseen_chars_reported(self):
        tok = CharTokenizer.train("abc")
        assert tok.unseen_chars("café ☕") == sorted(set("fé ☕"))
        assert tok.unseen_chars("cab") == []

    def test_vocab_size_is_types_plus_unk(self):
        assert CharTokenizer.train("aabbc").vocab_size == 4

    def test_empty_training_text(self):
        tok = CharTokenizer.train("")
        assert tok.vocab == [UNK]
        assert tok.decode(tok.encode("x")) == UNK

    def test_vocab_must_contain_unk(self):
        with pytest.raises(ValueError):
            CharTokenizer(["a"])
