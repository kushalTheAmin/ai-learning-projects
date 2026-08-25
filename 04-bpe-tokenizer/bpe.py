"""Byte-level byte-pair encoding, implemented from scratch.

Token ids 0..255 are the 256 raw byte values, so every possible input is
representable and encode/decode round-trips exactly for any valid unicode
string. Training learns merge rules on top of that base alphabet; merge i
produces token id 256 + i. Encoding applies merges strictly in the order
they were learned (lowest rank first), never greedily by token length.

Training is deterministic: ties on pair frequency break to the
lexicographically smallest (left_id, right_id) pair. Because each merge
depends only on the merges before it, a tokenizer trained to a smaller
vocab is exactly a prefix of one trained to a larger vocab on the same
corpus.
"""

import json
import re
from collections import Counter

# Splits text into pieces that merges may not cross: a word with at most
# one leading space, or a run of whitespace. Pieces always concatenate
# back to the original text.
_PRETOKEN_RE = re.compile(r" ?\S+|\s+")

_BASE_VOCAB = 256


def pretokenize(text):
    """Split text into merge-boundary pieces. "".join(result) == text."""
    return _PRETOKEN_RE.findall(text)


def _merge_seq(seq, pair, new_id):
    """Replace non-overlapping occurrences of pair in seq, left to right."""
    out = []
    i = 0
    while i < len(seq):
        if i + 1 < len(seq) and (seq[i], seq[i + 1]) == pair:
            out.append(new_id)
            i += 2
        else:
            out.append(seq[i])
            i += 1
    return tuple(out)


class ByteBPE:
    """A byte-level BPE tokenizer defined entirely by its merge list."""

    def __init__(self, merges=()):
        self.merges = [tuple(pair) for pair in merges]
        self._ranks = {pair: rank for rank, pair in enumerate(self.merges)}
        self._token_bytes = [bytes([i]) for i in range(_BASE_VOCAB)]
        for left, right in self.merges:
            self._token_bytes.append(
                self._token_bytes[left] + self._token_bytes[right]
            )
        self._piece_cache = {}

    @property
    def vocab_size(self):
        return _BASE_VOCAB + len(self.merges)

    def token_bytes(self, token_id):
        """The byte string a token id decodes to."""
        if not 0 <= token_id < self.vocab_size:
            raise ValueError(f"token id {token_id} outside vocab of size {self.vocab_size}")
        return self._token_bytes[token_id]

    @classmethod
    def train(cls, text, vocab_size):
        """Learn merges from text until vocab_size is reached or no pair
        occurs at least twice. Pair counts are weighted by how often each
        pretokenized piece occurs in the corpus."""
        if vocab_size < _BASE_VOCAB:
            raise ValueError(f"vocab_size must be >= {_BASE_VOCAB}, got {vocab_size}")
        piece_counts = Counter(pretokenize(text))
        seqs = {piece: tuple(piece.encode("utf-8")) for piece in piece_counts}
        merges = []
        while _BASE_VOCAB + len(merges) < vocab_size:
            pair_counts = Counter()
            for piece, count in piece_counts.items():
                seq = seqs[piece]
                for pair in zip(seq, seq[1:]):
                    pair_counts[pair] += count
            if not pair_counts:
                break
            # Highest count wins; ties break to the smallest pair so
            # training is fully deterministic.
            best = min(pair_counts, key=lambda p: (-pair_counts[p], p))
            if pair_counts[best] < 2:
                break
            new_id = _BASE_VOCAB + len(merges)
            merges.append(best)
            for piece, seq in seqs.items():
                if best[0] in seq:
                    seqs[piece] = _merge_seq(seq, best, new_id)
        return cls(merges)

    def truncated(self, vocab_size):
        """The tokenizer this training run would have produced at a smaller
        vocab: the first vocab_size - 256 merges."""
        if vocab_size < _BASE_VOCAB:
            raise ValueError(f"vocab_size must be >= {_BASE_VOCAB}, got {vocab_size}")
        return ByteBPE(self.merges[: vocab_size - _BASE_VOCAB])

    def _encode_piece(self, piece):
        cached = self._piece_cache.get(piece)
        if cached is not None:
            return cached
        seq = tuple(piece.encode("utf-8"))
        while len(seq) >= 2:
            pairs = set(zip(seq, seq[1:]))
            ranked = [p for p in pairs if p in self._ranks]
            if not ranked:
                break
            best = min(ranked, key=self._ranks.__getitem__)
            seq = _merge_seq(seq, best, _BASE_VOCAB + self._ranks[best])
        result = list(seq)
        self._piece_cache[piece] = result
        return result

    def encode(self, text):
        ids = []
        for piece in pretokenize(text):
            ids.extend(self._encode_piece(piece))
        return ids

    def decode(self, ids):
        """Decode token ids back to text. An id list produced by encode()
        always decodes to the exact original; arbitrary id lists that split
        a multi-byte character yield U+FFFD replacement characters rather
        than raising."""
        data = b"".join(self.token_bytes(i) for i in ids)
        return data.decode("utf-8", errors="replace")

    def save(self, path):
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"merges": self.merges}, f)

    @classmethod
    def load(cls, path):
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return cls(data["merges"])
