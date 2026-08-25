import pytest

from bpe import ByteBPE, pretokenize

TRICKY_STRINGS = [
    "",
    "a",
    " ",
    "   ",
    "  leading spaces",
    "trailing spaces  ",
    "\n\t mixed \r\n whitespace",
    "héllo wörld",
    "🚀🔥",
    "日本語のテキスト",
    "mixed 中文 and english",
    "quotes “curly” and \"straight\"",
    "a non-breaking space",
    "tabs\tbetween\twords",
]


class TestPretokenize:
    @pytest.mark.parametrize("text", TRICKY_STRINGS + ["a  b", " a", "a ", "  a  b  "])
    def test_pieces_rejoin_exactly(self, text):
        assert "".join(pretokenize(text)) == text

    def test_leading_space_attaches_to_word(self):
        assert pretokenize("the cat") == ["the", " cat"]

    def test_multiple_spaces_split_off(self):
        assert pretokenize("a  b") == ["a", "  ", "b"]


class TestTraining:
    def test_known_merge_sequence(self):
        # a=97 b=98 c=99 d=100. Pair (a,a) occurs 4 times, then after that
        # merge (aa,a) and (a,b) tie at 2 and the lex-smallest pair (a,b)
        # wins, then (aa,ab) occurs twice. Nothing else reaches count 2.
        bpe = ByteBPE.train("aaabdaaabac", 1000)
        assert bpe.merges == [(97, 97), (97, 98), (256, 257)]
        # aaab d aaab a c — the trailing "ac" pair never reaches count 2,
        # so its characters stay single-byte tokens.
        assert bpe.encode("aaabdaaabac") == [258, 100, 258, 97, 99]

    def test_pair_counts_weighted_by_piece_frequency(self):
        # Pieces: "hi" x1, " hi" x2, " abab" x1. Weighted, (h,i) has count 3
        # and wins. Counting each distinct piece once instead would tie
        # (a,b) with (h,i) at 2 and pick (a,b) — so this pins the weighting.
        bpe = ByteBPE.train("hi hi hi abab", 300)
        assert bpe.merges[0] == (104, 105)

    def test_frequency_ties_break_to_smallest_pair(self):
        # Pieces: "bb", " bb", " aa" x2. Pairs (b,b), ( ,a), (a,a) all have
        # count 2; the lex-smallest is (32, 97).
        bpe = ByteBPE.train("bb bb aa aa", 300)
        assert bpe.merges[0] == (32, 97)

    def test_no_merges_below_count_two(self):
        assert ByteBPE.train("abcdefg", 1000).merges == []

    def test_stops_at_requested_vocab(self):
        bpe = ByteBPE.train("the cat sat on the mat " * 30, 260)
        assert bpe.vocab_size == 260
        assert len(bpe.merges) == 4

    def test_smaller_vocab_is_prefix_of_larger(self):
        corpus = "the cat sat on the mat and the dog ran off " * 30
        small = ByteBPE.train(corpus, 264)
        large = ByteBPE.train(corpus, 280)
        assert small.merges == large.merges[:8]

    def test_truncated_matches_retraining(self):
        corpus = "the cat sat on the mat and the dog ran off " * 30
        large = ByteBPE.train(corpus, 280)
        retrained = ByteBPE.train(corpus, 264)
        assert large.truncated(264).merges == retrained.merges

    def test_vocab_below_256_rejected(self):
        with pytest.raises(ValueError):
            ByteBPE.train("abc", 255)
        with pytest.raises(ValueError):
            ByteBPE().truncated(100)

    def test_empty_and_whitespace_corpora(self):
        assert ByteBPE.train("", 1000).merges == []
        # "    " is a single whitespace piece with pair (32,32) count 3... a
        # single piece occurring once still yields within-piece pair counts.
        bpe = ByteBPE.train("    ", 1000)
        assert all(bpe.token_bytes(256 + i).isspace() for i in range(len(bpe.merges)))

    def test_tokens_never_span_a_word_boundary(self):
        corpus = "the cat sat on the mat.\nthe dog sat on the log.\n" * 20
        bpe = ByteBPE.train(corpus, 400)
        assert len(bpe.merges) > 0
        for token_id in range(256, bpe.vocab_size):
            data = bpe.token_bytes(token_id)
            if b" " in data[1:]:
                # An interior space is only legal in an all-whitespace token.
                assert data.isspace()


class TestEncodeDecode:
    @pytest.mark.parametrize("text", TRICKY_STRINGS)
    def test_round_trip_untrained(self, text):
        bpe = ByteBPE()
        assert bpe.decode(bpe.encode(text)) == text

    @pytest.mark.parametrize("text", TRICKY_STRINGS)
    def test_round_trip_trained(self, text):
        bpe = ByteBPE.train("the cat sat on the mat " * 30, 300)
        assert bpe.decode(bpe.encode(text)) == text

    def test_empty_encodes_to_nothing(self):
        assert ByteBPE().encode("") == []
        assert ByteBPE().decode([]) == ""

    def test_merges_apply_in_rank_order_not_leftmost(self):
        # Rank 0 is (b,c), rank 1 is (a,b). Encoding "abc" must apply the
        # lower rank first even though (a,b) sits further left, giving
        # [a, bc] — a leftmost-first or rank-reversed encoder gives [ab, c].
        bpe = ByteBPE(merges=[(98, 99), (97, 98)])
        assert bpe.encode("abc") == [97, 256]

    def test_learned_merges_are_used(self):
        bpe = ByteBPE.train("aaabdaaabac", 1000)
        assert bpe.encode("aaab") == [258]
        assert bpe.decode([258]) == "aaab"

    def test_oversized_input_round_trips(self):
        bpe = ByteBPE.train("lorem ipsum dolor sit amet " * 30, 300)
        text = "lorem ipsum dolor sit amet consectetur " * 2500
        ids = bpe.encode(text)
        assert bpe.decode(ids) == text
        assert len(ids) < len(text.encode("utf-8"))

    def test_unseen_bytes_fall_back_to_byte_tokens(self):
        bpe = ByteBPE.train("plain ascii only " * 20, 300)
        ids = bpe.encode("🚀")
        assert ids == list("🚀".encode("utf-8"))

    def test_decode_of_partial_utf8_replaces_instead_of_raising(self):
        # 0xC8 opens a two-byte sequence that never completes.
        assert ByteBPE().decode([0xC8]) == "�"

    def test_decode_rejects_out_of_vocab_ids(self):
        with pytest.raises(ValueError):
            ByteBPE().decode([256])
        with pytest.raises(ValueError):
            ByteBPE().decode([-1])

    def test_encode_is_deterministic(self):
        bpe = ByteBPE.train("the cat sat on the mat " * 30, 300)
        text = "the mat sat on the cat"
        assert bpe.encode(text) == bpe.encode(text)


class TestVocabAndPersistence:
    def test_vocab_size_counts_base_plus_merges(self):
        assert ByteBPE().vocab_size == 256
        bpe = ByteBPE.train("aaabdaaabac", 1000)
        assert bpe.vocab_size == 256 + len(bpe.merges) == 259

    def test_token_bytes_expand_merges(self):
        bpe = ByteBPE.train("aaabdaaabac", 1000)
        assert bpe.token_bytes(97) == b"a"
        assert bpe.token_bytes(256) == b"aa"
        assert bpe.token_bytes(258) == b"aaab"
        with pytest.raises(ValueError):
            bpe.token_bytes(259)

    def test_truncated_to_base_vocab_has_no_merges(self):
        bpe = ByteBPE.train("the cat sat on the mat " * 30, 300)
        assert bpe.truncated(256).merges == []
        assert bpe.truncated(bpe.vocab_size).merges == bpe.merges

    def test_save_load_round_trip(self, tmp_path):
        bpe = ByteBPE.train("the cat sat on the mat " * 30, 320)
        path = tmp_path / "tokenizer.json"
        bpe.save(path)
        loaded = ByteBPE.load(path)
        assert loaded.merges == bpe.merges
        text = "the dog sat on the cat"
        assert loaded.encode(text) == bpe.encode(text)
