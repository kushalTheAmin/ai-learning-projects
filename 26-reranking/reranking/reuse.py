"""Imports 03-hybrid-search's retrieval stack and 02-retrieval-eval's metrics.

Reranking changes how the top of a candidate list is ordered, not how the
first stage retrieves or how quality is scored. 03's BM25, DenseLSA,
tokenizer and RRF fusion are imported so the first stages here are exactly
the retrievers 03 measured, and 02's metrics and paired bootstrap are
imported so every number is comparable to the rest of the repo by
construction.
"""

import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]

for _sibling in ("02-retrieval-eval", "03-hybrid-search"):
    _dir = _REPO_ROOT / _sibling
    if not _dir.is_dir():
        raise ImportError(
            f"expected sibling project at {_dir}; "
            f"26-reranking must live next to {_sibling}"
        )
    if str(_dir) not in sys.path:
        sys.path.insert(0, str(_dir))

from hybrid_search.bm25 import BM25  # noqa: E402
from hybrid_search.dense import DenseLSA  # noqa: E402
from hybrid_search.fusion import reciprocal_rank_fusion  # noqa: E402
from hybrid_search.tokenize import tokenize  # noqa: E402
from retrieval_eval.bootstrap import PairedComparison, paired_bootstrap  # noqa: E402
from retrieval_eval.metrics import mean, recall_at_k, reciprocal_rank  # noqa: E402

__all__ = [
    "BM25",
    "DenseLSA",
    "PairedComparison",
    "mean",
    "paired_bootstrap",
    "recall_at_k",
    "reciprocal_rank",
    "reciprocal_rank_fusion",
    "tokenize",
]
