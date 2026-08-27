"""Imports 02-retrieval-eval's BM25, metrics, and tokenizer.

Chunking changes what goes *into* the index, not how the index scores.
Reusing 02's implementation keeps the two projects' BM25 semantics
identical by construction instead of by promise.
"""

import sys
from pathlib import Path

_RETRIEVAL_EVAL_DIR = Path(__file__).resolve().parents[2] / "02-retrieval-eval"
if not _RETRIEVAL_EVAL_DIR.is_dir():
    raise ImportError(
        f"expected sibling project at {_RETRIEVAL_EVAL_DIR}; "
        "10-chunking-strategies must live next to 02-retrieval-eval"
    )
if str(_RETRIEVAL_EVAL_DIR) not in sys.path:
    sys.path.insert(0, str(_RETRIEVAL_EVAL_DIR))

from retrieval_eval.bm25 import BM25Index  # noqa: E402
from retrieval_eval.metrics import mean, reciprocal_rank  # noqa: E402
from retrieval_eval.tokenizer import tokenize  # noqa: E402

__all__ = ["BM25Index", "mean", "reciprocal_rank", "tokenize"]
