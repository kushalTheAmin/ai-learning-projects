"""Shared tokenizer used by both the lexical and dense retrievers.

Both sides must see identical tokens, otherwise a comparison between them
measures tokenization differences instead of retrieval differences.
"""

import re

_TOKEN_RE = re.compile(r"[a-z0-9]+(?:[-_][a-z0-9]+)*", re.UNICODE)

STOPWORDS = frozenset(
    """a an and are as at be but by can do does for from has have how i if in
    is it its my of on or so that the this to was what when where which why
    will with you your""".split()
)

_DOUBLE_CONSONANT_RE = re.compile(r"[bcdfghjklmnpqrstvz]$")


def _undouble(word: str) -> str:
    if len(word) > 3 and word[-1] == word[-2] and _DOUBLE_CONSONANT_RE.search(word):
        return word[:-1]
    return word


def stem(word: str) -> str:
    """Naive suffix stripper: plural, -ing, -ed, trailing -e.

    Deliberately simple; it only needs to map morphological variants
    (delete/deleted/deleting, cache/caching) onto one form, identically
    for documents and queries.
    """
    if len(word) <= 3:
        return word
    if word.endswith("ies") and len(word) > 4:
        word = word[:-3] + "y"
    elif word.endswith("ss"):
        pass
    elif word.endswith("s"):
        word = word[:-1]
    if word.endswith("ing") and len(word) > 5:
        word = _undouble(word[:-3])
    elif word.endswith("ed") and len(word) > 4:
        word = _undouble(word[:-2])
    if word.endswith("e") and len(word) > 4:
        word = word[:-1]
    return word


def tokenize(text: str) -> list[str]:
    """Lowercase, split on non-alphanumerics, drop stopwords, apply the
    naive stemmer.

    Hyphen/underscore compounds are kept whole AND split into parts:
    "force-with-lease" emits itself (so the exact flag stays searchable)
    plus "force" and "lease" (so "logged-in" can still match "logged").
    """
    tokens = []
    for raw in _TOKEN_RE.findall(text.lower()):
        if raw not in STOPWORDS:
            tokens.append(stem(raw))
        if "-" in raw or "_" in raw:
            parts = re.split(r"[-_]", raw)
            tokens.extend(stem(p) for p in parts if p and p not in STOPWORDS)
    return tokens
