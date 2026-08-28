"""Imports 02-retrieval-eval's recall_at_k.

ANN recall@k is the fraction of the true top-k that the approximate index
returned, which is exactly 02's recall_at_k with the exact top-k ids as the
relevant set. Importing it keeps the metric's semantics identical across the
repo instead of identical by promise.
"""

import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[2]
_SIBLING = _ROOT / "02-retrieval-eval"
if not _SIBLING.is_dir():
    raise ImportError(
        f"expected sibling project at {_SIBLING}; 13-ann-hnsw must live next to it"
    )
if str(_SIBLING) not in sys.path:
    sys.path.insert(0, str(_SIBLING))

from retrieval_eval.metrics import mean, recall_at_k  # noqa: E402

__all__ = ["mean", "recall_at_k"]


def ann_recall(
    approx: list[tuple[int, float]], exact: list[tuple[int, float]], k: int
) -> float:
    """Recall@k of an approximate result list against the exact one.

    Both lists are (id, distance) pairs nearest-first, as the indexes return
    them. Ids are stringified because 02's metric contract takes string doc ids.
    """
    return recall_at_k(
        [str(node) for node, _ in approx], [str(node) for node, _ in exact[:k]], k
    )
