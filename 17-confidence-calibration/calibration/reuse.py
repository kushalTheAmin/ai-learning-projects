"""Imports 02-retrieval-eval's tokenizer.

The feature extractor here needs a word tokenizer and the repo already
has one with pinned semantics (unicode word runs, underscores split,
casefold). Importing it keeps tokenization identical to 02 and 12 by
construction instead of by promise.
"""

import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[2]
_DIR = _ROOT / "02-retrieval-eval"
if not _DIR.is_dir():
    raise ImportError(
        f"expected sibling project at {_DIR}; "
        "17-confidence-calibration must live next to it"
    )
if str(_DIR) not in sys.path:
    sys.path.insert(0, str(_DIR))

from retrieval_eval.tokenizer import tokenize  # noqa: E402

__all__ = ["tokenize"]
