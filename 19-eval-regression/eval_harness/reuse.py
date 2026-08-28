"""Imports 02-retrieval-eval's paired bootstrap.

The regression gate's statistics are exactly 02's machinery: percentile
bootstrap intervals over paired per-item differences. Importing it
keeps one implementation of the resampling in the repo instead of a
second one that could disagree on interpolation or seeding.
"""

import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[2]
_DIR = _ROOT / "02-retrieval-eval"
if not _DIR.is_dir():
    raise ImportError(
        f"expected sibling project at {_DIR}; "
        "19-eval-regression must live next to it"
    )
if str(_DIR) not in sys.path:
    sys.path.insert(0, str(_DIR))

from retrieval_eval.bootstrap import PairedComparison, paired_bootstrap  # noqa: E402

__all__ = ["PairedComparison", "paired_bootstrap"]
