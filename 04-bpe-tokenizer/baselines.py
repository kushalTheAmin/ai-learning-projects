"""Baseline tokenizers BPE is measured against.

WordTokenizer is a closed-vocabulary word-level tokenizer: the top-N word
types from training by frequency, everything else becomes UNK. It is lossy
by construction — that is the failure mode byte-level BPE exists to avoid.

CharTokenizer maps each character seen in training to an id, with UNK for
unseen characters. Even character-level tokenization has out-of-vocabulary
inputs unless the base alphabet is bytes.
"""

import re
from collections import Counter

_WORD_RE = re.compile(r"\S+|\s+")

UNK = "<unk>"


def word_split(text):
    """Split into word and whitespace runs. "".join(result) == text."""
    return _WORD_RE.findall(text)


class WordTokenizer:
    def __init__(self, vocab):
        self.vocab = list(vocab)
        self._ids = {tok: i for i, tok in enumerate(self.vocab)}
        if UNK not in self._ids:
            raise ValueError(f"vocab must contain {UNK}")

    @property
    def vocab_size(self):
        return len(self.vocab)

    @classmethod
    def train(cls, text, vocab_size):
        """Top vocab_size - 1 word types by frequency, plus UNK. Frequency
        ties break alphabetically so training is deterministic."""
        if vocab_size < 1:
            raise ValueError("vocab_size must be >= 1")
        counts = Counter(word_split(text))
        ranked = sorted(counts, key=lambda w: (-counts[w], w))
        return cls([UNK] + ranked[: vocab_size - 1])

    def encode(self, text):
        unk_id = self._ids[UNK]
        return [self._ids.get(tok, unk_id) for tok in word_split(text)]

    def decode(self, ids):
        return "".join(self.vocab[i] for i in ids)

    def oov_stats(self, text):
        """(oov_tokens, total_tokens) over the word runs of text —
        whitespace runs count like any other token."""
        tokens = word_split(text)
        oov = sum(1 for tok in tokens if tok not in self._ids)
        return oov, len(tokens)


class CharTokenizer:
    def __init__(self, vocab):
        self.vocab = list(vocab)
        self._ids = {ch: i for i, ch in enumerate(self.vocab)}
        if UNK not in self._ids:
            raise ValueError(f"vocab must contain {UNK}")

    @property
    def vocab_size(self):
        return len(self.vocab)

    @classmethod
    def train(cls, text):
        return cls([UNK] + sorted(set(text)))

    def encode(self, text):
        unk_id = self._ids[UNK]
        return [self._ids.get(ch, unk_id) for ch in text]

    def decode(self, ids):
        return "".join(self.vocab[i] for i in ids)

    def unseen_chars(self, text):
        """Distinct characters of text missing from the vocab."""
        return sorted(set(text) - set(self._ids))
