"""Golden dataset: items, validation, canonical fingerprint.

A golden item is one eval case: an input, the expected answer, a
plausible wrong answer (the distractor a failing model emits), and a
per-item difficulty offset the scripted model adds to its category
skill. The fingerprint pins the exact dataset a run was scored on, so
two runs can only be compared when they measured the same thing.
"""

import hashlib
import json
import re
from dataclasses import asdict, dataclass
from pathlib import Path

CATEGORIES = ("arithmetic", "date", "entity", "format", "negation", "unit")

MAX_DIFFICULTY = 0.5

_WHITESPACE = re.compile(r"\s+")


def normalize(text: str) -> str:
    """Canonical answer form: casefold, trim, collapse inner whitespace."""
    return _WHITESPACE.sub(" ", text.casefold().strip())


@dataclass(frozen=True)
class GoldenItem:
    item_id: str
    category: str
    input_text: str
    expected: str
    distractor: str
    difficulty: float  # offset added to the scripted model's category skill


def validate_items(items: list[GoldenItem]) -> None:
    if not items:
        raise ValueError("golden dataset must be non-empty")
    seen_ids: set[str] = set()
    seen_inputs: set[str] = set()
    for item in items:
        if item.item_id in seen_ids:
            raise ValueError(f"duplicate item id: {item.item_id}")
        seen_ids.add(item.item_id)
        if item.input_text in seen_inputs:
            raise ValueError(f"duplicate input text on {item.item_id}")
        seen_inputs.add(item.input_text)
        if item.category not in CATEGORIES:
            raise ValueError(f"unknown category {item.category!r} on {item.item_id}")
        if not item.input_text.strip():
            raise ValueError(f"empty input on {item.item_id}")
        if not normalize(item.expected):
            raise ValueError(f"empty expected answer on {item.item_id}")
        if normalize(item.expected) == normalize(item.distractor):
            raise ValueError(
                f"distractor normalizes equal to expected on {item.item_id}"
            )
        if not -MAX_DIFFICULTY <= item.difficulty <= MAX_DIFFICULTY:
            raise ValueError(
                f"difficulty {item.difficulty} out of range on {item.item_id}"
            )


def dataset_fingerprint(items: list[GoldenItem]) -> str:
    """sha256 over the canonical serialization of every item, in order."""
    payload = json.dumps(
        [asdict(item) for item in items], sort_keys=True, ensure_ascii=True
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def save_golden(items: list[GoldenItem], path: Path) -> None:
    validate_items(items)
    lines = [json.dumps(asdict(item), sort_keys=True) for item in items]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def load_golden(path: Path) -> list[GoldenItem]:
    raw = path.read_text(encoding="utf-8")
    items: list[GoldenItem] = []
    for line_no, line in enumerate(raw.splitlines(), start=1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"line {line_no} is not valid json: {exc}") from exc
        try:
            items.append(GoldenItem(**record))
        except TypeError as exc:
            raise ValueError(f"line {line_no} has wrong fields: {exc}") from exc
    validate_items(items)
    return items
