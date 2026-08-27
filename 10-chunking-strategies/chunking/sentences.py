"""Sentence splitting with character spans into the original text.

Spans matter because chunks are later defined as substrings of the
document; a chunk "contains" a gold answer only if the exact answer text
survives inside it, and that check is meaningless unless sentences map
back to real offsets.
"""

import re
from dataclasses import dataclass

# a sentence-boundary candidate: a terminator run, optional closing
# quotes/brackets, then whitespace. requiring the whitespace keeps
# decimals like 99.95 and dotted names like logs.raw intact. whether the
# candidate is a real boundary depends on what follows — checked in
# _starts_sentence, because "uppercase letter" is not expressible as an
# ascii character class once text leaves ascii.
_BOUNDARY_RE = re.compile(r"[.!?]+[\"')\]]*(\s+)")
_OPENERS = "\"'(["

# words whose trailing period does not end a sentence
_ABBREVIATIONS = {"e.g", "i.e", "etc", "vs", "approx"}
_LAST_WORD_RE = re.compile(r"[^\s(]+$")


@dataclass(frozen=True)
class Sentence:
    text: str
    start: int
    end: int  # exclusive


def split_sentences(text: str) -> list[Sentence]:
    """Split text into sentences with [start, end) character spans.

    text[s.start:s.end] == s.text for every sentence, sentences never
    overlap, and only whitespace falls between consecutive spans.
    """
    sentences: list[Sentence] = []
    cursor = 0
    for match in _BOUNDARY_RE.finditer(text):
        if not _starts_sentence(text, match.end()):
            continue
        if _ends_with_abbreviation(text, match.start()):
            continue
        _append_stripped(sentences, text, cursor, match.start(1))
        cursor = match.end()
    _append_stripped(sentences, text, cursor, len(text))
    return sentences


def _starts_sentence(text: str, position: int) -> bool:
    if position < len(text) and text[position] in _OPENERS:
        position += 1
    if position >= len(text):
        return False
    ch = text[position]
    return ch.isupper() or ch.isdigit()


def _ends_with_abbreviation(text: str, terminator_start: int) -> bool:
    last_word = _LAST_WORD_RE.search(text[:terminator_start])
    return last_word is not None and last_word.group().casefold() in _ABBREVIATIONS


def _append_stripped(sentences: list[Sentence], text: str, start: int, end: int) -> None:
    raw = text[start:end]
    stripped = raw.strip()
    if not stripped:
        return
    lead = len(raw) - len(raw.lstrip())
    s = start + lead
    sentences.append(Sentence(text=stripped, start=s, end=s + len(stripped)))
