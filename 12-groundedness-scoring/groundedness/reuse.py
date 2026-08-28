"""Imports 02-retrieval-eval's tokenizer and tf-idf index and
10-chunking-strategies' sentence splitter.

Groundedness scoring here is lexical alignment between a claim and the
context it cites. The alignment machinery already exists in this repo:
02 owns the tokenizer and the tf-idf cosine, 10 owns sentence splitting.
Importing them keeps the semantics identical by construction instead of
by promise.
"""

import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[2]
for _sibling in ("02-retrieval-eval", "10-chunking-strategies"):
    _dir = _ROOT / _sibling
    if not _dir.is_dir():
        raise ImportError(
            f"expected sibling project at {_dir}; "
            "12-groundedness-scoring must live next to it"
        )
    if str(_dir) not in sys.path:
        sys.path.insert(0, str(_dir))

from chunking.sentences import Sentence, split_sentences  # noqa: E402
from retrieval_eval.tfidf import TfidfIndex  # noqa: E402
from retrieval_eval.tokenizer import tokenize  # noqa: E402

__all__ = ["Sentence", "split_sentences", "TfidfIndex", "tokenize"]
