"""Imports 13-ann-hnsw's index, datasets, and recall metric.

Persistence and mutation wrap the index, they do not change how it
searches: MutableHnswIndex subclasses 13's HnswIndex and adds tombstones,
unlinking, compaction, and a serializable state, while every search still
runs 13's exact code path. Importing (rather than copying) keeps the
recall and cost numbers here comparable with 13's sweep instead of
comparable by promise.
"""

import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[2]
_SIBLING = _ROOT / "13-ann-hnsw"
if not _SIBLING.is_dir():
    raise ImportError(
        f"expected sibling project at {_SIBLING}; "
        "21-vector-store-persistence must live next to it"
    )
if str(_SIBLING) not in sys.path:
    sys.path.insert(0, str(_SIBLING))

from ann.dataset import Dataset, clustered_dataset, uniform_dataset  # noqa: E402
from ann.exact import ExactIndex  # noqa: E402
from ann.hnsw import HnswIndex  # noqa: E402
from ann.reuse import ann_recall, mean  # noqa: E402

__all__ = [
    "Dataset",
    "clustered_dataset",
    "uniform_dataset",
    "ExactIndex",
    "HnswIndex",
    "ann_recall",
    "mean",
]
