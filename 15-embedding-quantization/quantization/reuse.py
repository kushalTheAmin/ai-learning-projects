"""Imports 13-ann-hnsw's indexes, datasets, and recall metric.

Quantization changes what the index stores, not how it searches: both of
13's indexes take float vectors, so feeding them the dequantized
reconstruction measures exactly what int8 storage costs at search time.
Importing them (and the recall metric 13 itself imports from 02) keeps
every number here comparable with 13's sweep instead of comparable by
promise.
"""

import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[2]
_SIBLING = _ROOT / "13-ann-hnsw"
if not _SIBLING.is_dir():
    raise ImportError(
        f"expected sibling project at {_SIBLING}; "
        "15-embedding-quantization must live next to it"
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
