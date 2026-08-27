"""Seeded document mutations that manufacture labeled near-duplicates.

Each mutation models a duplication pattern real dedup pipelines see:
scraped copies with OCR-style typos, boilerplate with sentences reordered,
articles trimmed for length, copies with words dropped or doubled, and
byte-identical content that differs only in case and whitespace.
"""

from __future__ import annotations

import random
import re

SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")


def with_typos(text: str, rng: random.Random) -> str:
    """Character-level edits (swap, drop, double) at roughly 2% of positions."""
    chars = list(text)
    edits = max(3, len(chars) // 50)
    for _ in range(edits):
        i = rng.randrange(len(chars))
        op = rng.choice(("swap", "drop", "double"))
        if op == "swap" and i < len(chars) - 1:
            chars[i], chars[i + 1] = chars[i + 1], chars[i]
        elif op == "drop" and len(chars) > 1:
            del chars[i]
        else:
            chars.insert(i, chars[i])
    return "".join(chars)


def drop_words(text: str, rng: random.Random) -> str:
    """Remove roughly 10% of words, always at least one."""
    words = text.split()
    if len(words) < 2:
        return text
    n_drop = max(1, len(words) // 10)
    drop_at = set(rng.sample(range(len(words)), n_drop))
    return " ".join(w for i, w in enumerate(words) if i not in drop_at)


def shuffle_sentences(text: str, rng: random.Random) -> str:
    """Reorder sentences, guaranteed different from the original order."""
    sentences = SENTENCE_SPLIT.split(text)
    if len(sentences) < 2:
        return text
    original = list(sentences)
    while sentences == original:
        rng.shuffle(sentences)
    return " ".join(sentences)


def truncate(text: str, rng: random.Random) -> str:
    """Keep the first 70% of words."""
    words = text.split()
    keep = max(1, (len(words) * 7) // 10)
    return " ".join(words[:keep])


def case_and_whitespace_noise(text: str, rng: random.Random) -> str:
    """Random case flips and doubled spaces; invisible after normalization."""
    out: list[str] = []
    for ch in text:
        if ch.isalpha() and rng.random() < 0.15:
            ch = ch.swapcase()
        out.append(ch)
        if ch == " " and rng.random() < 0.2:
            out.append(" ")
    return "".join(out)


MUTATIONS: dict[str, object] = {
    "typo": with_typos,
    "drop": drop_words,
    "shuffle": shuffle_sentences,
    "truncate": truncate,
    "noise": case_and_whitespace_noise,
}
