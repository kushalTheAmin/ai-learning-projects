"""Imports 02-retrieval-eval's retrieval stack and 23's PRF term extraction.

Query rewriting changes what the search string says, not how the index
scores it. 02's BM25, tokenizer, metrics and paired bootstrap are imported
so every number here is comparable to the rest of the repo by construction.
23's extract_bridge_terms IS pseudo-relevance feedback (tf*idf novel terms
from a retrieved doc, question terms excluded); here it expands a one-hop
query instead of building a second hop.
"""

import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]

for _sibling in ("02-retrieval-eval", "23-multi-hop-retrieval"):
    _dir = _REPO_ROOT / _sibling
    if not _dir.is_dir():
        raise ImportError(
            f"expected sibling project at {_dir}; "
            f"25-query-rewriting must live next to {_sibling}"
        )
    if str(_dir) not in sys.path:
        sys.path.insert(0, str(_dir))

from multihop.bridge import extract_bridge_terms  # noqa: E402
from retrieval_eval.bm25 import BM25Index  # noqa: E402
from retrieval_eval.bootstrap import PairedComparison, paired_bootstrap  # noqa: E402
from retrieval_eval.metrics import mean, recall_at_k, reciprocal_rank  # noqa: E402
from retrieval_eval.tokenizer import tokenize  # noqa: E402

__all__ = [
    "BM25Index",
    "PairedComparison",
    "extract_bridge_terms",
    "mean",
    "paired_bootstrap",
    "recall_at_k",
    "reciprocal_rank",
    "tokenize",
]
