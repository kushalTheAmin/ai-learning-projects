"""Run an eval, persist the run record, load it back with integrity checks.

A RunRecord is the artifact a CI system would store per eval run: which
model, which seed, the fingerprint of the exact dataset, every per-item
outcome, and the aggregate and per-category accuracies. load_run
recomputes the aggregates from the stored outcomes and rejects a record
that disagrees with itself, so a tampered or truncated artifact fails
loudly instead of gating a release.
"""

import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Mapping

from .data import GoldenItem, dataset_fingerprint, normalize
from .model import ScriptedModel

SCHEMA_VERSION = 1


@dataclass(frozen=True)
class ItemOutcome:
    item_id: str
    category: str
    answer: str
    correct: bool


@dataclass(frozen=True)
class RunRecord:
    schema_version: int
    model_name: str
    eval_seed: int
    fingerprint: str
    outcomes: tuple[ItemOutcome, ...]
    accuracy: float
    category_accuracy: Mapping[str, float]


def _accuracy(outcomes: tuple[ItemOutcome, ...]) -> float:
    return sum(1 for o in outcomes if o.correct) / len(outcomes)


def _category_accuracy(outcomes: tuple[ItemOutcome, ...]) -> dict[str, float]:
    by_category: dict[str, list[bool]] = {}
    for outcome in outcomes:
        by_category.setdefault(outcome.category, []).append(outcome.correct)
    return {
        category: sum(flags) / len(flags)
        for category, flags in sorted(by_category.items())
    }


def run_eval(
    model: ScriptedModel, items: list[GoldenItem], eval_seed: int
) -> RunRecord:
    if not items:
        raise ValueError("cannot run an eval over zero items")
    outcomes = []
    for item in items:
        answer = model.answer(item, eval_seed)
        correct = normalize(answer) == normalize(item.expected)
        outcomes.append(
            ItemOutcome(
                item_id=item.item_id,
                category=item.category,
                answer=answer,
                correct=correct,
            )
        )
    outcomes = tuple(outcomes)
    return RunRecord(
        schema_version=SCHEMA_VERSION,
        model_name=model.name,
        eval_seed=eval_seed,
        fingerprint=dataset_fingerprint(items),
        outcomes=outcomes,
        accuracy=_accuracy(outcomes),
        category_accuracy=_category_accuracy(outcomes),
    )


def save_run(record: RunRecord, path: Path) -> None:
    payload = asdict(record)
    payload["category_accuracy"] = dict(record.category_accuracy)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


def load_run(path: Path) -> RunRecord:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"run record {path} is not valid json: {exc}") from exc
    if not isinstance(payload, dict):
        raise ValueError(f"run record {path} must be a json object")
    if payload.get("schema_version") != SCHEMA_VERSION:
        raise ValueError(
            f"run record {path} has schema_version "
            f"{payload.get('schema_version')!r}, expected {SCHEMA_VERSION}"
        )
    try:
        outcomes = tuple(ItemOutcome(**o) for o in payload["outcomes"])
        record = RunRecord(
            schema_version=payload["schema_version"],
            model_name=payload["model_name"],
            eval_seed=payload["eval_seed"],
            fingerprint=payload["fingerprint"],
            outcomes=outcomes,
            accuracy=payload["accuracy"],
            category_accuracy=payload["category_accuracy"],
        )
    except (KeyError, TypeError) as exc:
        raise ValueError(f"run record {path} has wrong fields: {exc}") from exc
    if not outcomes:
        raise ValueError(f"run record {path} holds zero outcomes")
    if record.accuracy != _accuracy(outcomes):
        raise ValueError(
            f"run record {path} stores accuracy {record.accuracy} but its "
            f"outcomes recompute to {_accuracy(outcomes)}"
        )
    if dict(record.category_accuracy) != _category_accuracy(outcomes):
        raise ValueError(
            f"run record {path} per-category accuracies disagree with its outcomes"
        )
    return record
