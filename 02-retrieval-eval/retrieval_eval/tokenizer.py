import re

# runs of word characters, underscores excluded; \w is unicode-aware so
# accented and CJK text tokenizes instead of disappearing
_TOKEN_RE = re.compile(r"[^\W_]+")


def tokenize(text: str) -> list[str]:
    return [match.casefold() for match in _TOKEN_RE.findall(text)]
