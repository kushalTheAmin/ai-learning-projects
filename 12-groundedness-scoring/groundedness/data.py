"""Load and validate the labeled claim dataset.

One JSONL record per context: the passage plus a list of claims, each
labeled supported/unsupported and tagged with the category of edit that
produced it. The categories are the point: they let the evaluation say
WHICH failure shapes a scorer catches, not just how often it is right.
"""

import json
from dataclasses import dataclass
from pathlib import Path

SUPPORTED_CATEGORIES = frozenset(
    {"verbatim", "paraphrase", "synthesis", "negated_paraphrase"}
)
UNSUPPORTED_CATEGORIES = frozenset(
    {
        "entity_swap",
        "number_swap",
        "negation_flip",
        "antonym_flip",
        "fabricated",
        "outside_knowledge",
    }
)
CATEGORIES = SUPPORTED_CATEGORIES | UNSUPPORTED_CATEGORIES


@dataclass(frozen=True)
class Claim:
    id: str
    text: str
    supported: bool
    category: str


@dataclass(frozen=True)
class Context:
    id: str
    text: str
    claims: tuple[Claim, ...]


def load_contexts(path: Path) -> list[Context]:
    contexts: list[Context] = []
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            line = line.strip()
            if not line:
                continue
            record = json.loads(line)
            contexts.append(_parse_context(record, line_number))
    validate(contexts)
    return contexts


def _parse_context(record: dict, line_number: int) -> Context:
    claims = tuple(
        Claim(
            id=claim["id"],
            text=claim["text"],
            supported=claim["supported"],
            category=claim["category"],
        )
        for claim in record["claims"]
    )
    return Context(id=record["id"], text=record["context"], claims=claims)


def validate(contexts: list[Context]) -> None:
    if not contexts:
        raise ValueError("dataset is empty")
    seen_context_ids: set[str] = set()
    seen_claim_ids: set[str] = set()
    for context in contexts:
        if not context.text.strip():
            raise ValueError(f"context {context.id} has empty text")
        if context.id in seen_context_ids:
            raise ValueError(f"duplicate context id {context.id}")
        seen_context_ids.add(context.id)
        if not context.claims:
            raise ValueError(f"context {context.id} has no claims")
        for claim in context.claims:
            if not claim.text.strip():
                raise ValueError(f"claim {claim.id} has empty text")
            if claim.id in seen_claim_ids:
                raise ValueError(f"duplicate claim id {claim.id}")
            seen_claim_ids.add(claim.id)
            if claim.category not in CATEGORIES:
                raise ValueError(
                    f"claim {claim.id} has unknown category {claim.category!r}"
                )
            expected = claim.category in SUPPORTED_CATEGORIES
            if claim.supported != expected:
                raise ValueError(
                    f"claim {claim.id}: category {claim.category!r} "
                    f"implies supported={expected}, record says {claim.supported}"
                )
