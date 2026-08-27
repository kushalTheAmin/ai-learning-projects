"""Three chunking strategies, all producing substrings of the document.

Every chunk carries its [start, end) character span, so containment of a
gold answer is an exact substring check against real document text, never
a reconstruction from tokens.

Sizes are counted in whitespace-delimited words. That is deliberately the
crudest unit: it is what most chunking code in the wild uses, and the
point of the project is boundary placement, not tokenizer fidelity.
"""

import re
from dataclasses import dataclass

from .sentences import Sentence, split_sentences

_WORD_RE = re.compile(r"\S+")


@dataclass(frozen=True)
class Chunk:
    doc_id: str
    index: int
    text: str
    start: int
    end: int  # exclusive

    @property
    def id(self) -> str:
        return f"{self.doc_id}#{self.index}"


def fixed_chunks(doc_id: str, text: str, size: int, overlap: int = 0) -> list[Chunk]:
    """Windows of `size` words advancing by `size - overlap` words.

    overlap=0 is plain fixed-size chunking. The final window is the one
    that reaches the last word; a shorter tail window is emitted as-is
    rather than padded or merged.
    """
    if size < 1:
        raise ValueError(f"size must be >= 1, got {size}")
    if not 0 <= overlap < size:
        raise ValueError(f"overlap must be in [0, size), got {overlap} for size {size}")
    words = list(_WORD_RE.finditer(text))
    if not words:
        return []
    stride = size - overlap
    chunks: list[Chunk] = []
    for window_start in range(0, len(words), stride):
        window = words[window_start : window_start + size]
        start, end = window[0].start(), window[-1].end()
        chunks.append(
            Chunk(doc_id=doc_id, index=len(chunks), text=text[start:end], start=start, end=end)
        )
        if window_start + size >= len(words):
            break
    return chunks


def sentence_chunks(doc_id: str, text: str, budget: int) -> list[Chunk]:
    """Greedy packing of whole sentences up to `budget` words per chunk.

    A sentence is never split: one longer than the budget becomes its own
    oversized chunk. This is the strategy's defining trade — chunk sizes
    vary, but no fact that lives inside one sentence can be cut in half.
    """
    if budget < 1:
        raise ValueError(f"budget must be >= 1, got {budget}")
    sentences = split_sentences(text)
    chunks: list[Chunk] = []
    group_start = 0
    group_words = 0
    for i, sentence in enumerate(sentences):
        n_words = len(_WORD_RE.findall(sentence.text))
        if group_words and group_words + n_words > budget:
            _flush(chunks, doc_id, text, sentences[group_start:i])
            group_start, group_words = i, 0
        group_words += n_words
    _flush(chunks, doc_id, text, sentences[group_start:])
    return chunks


def _flush(chunks: list[Chunk], doc_id: str, text: str, group: list[Sentence]) -> None:
    if not group:
        return
    start, end = group[0].start, group[-1].end
    chunks.append(
        Chunk(doc_id=doc_id, index=len(chunks), text=text[start:end], start=start, end=end)
    )


def word_count(text: str) -> int:
    return len(_WORD_RE.findall(text))
