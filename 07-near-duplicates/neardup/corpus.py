"""Corpus assembly: committed base documents plus seeded mutants.

Ground truth is by provenance, not similarity: every pair of documents
descending from the same base (base-to-mutant and mutant-to-mutant alike)
is a true duplicate pair, and every cross-base pair is not, including the
same-topic pairs that share vocabulary without sharing origin.
"""

from __future__ import annotations

import json
import random
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from .mutations import MUTATIONS


@dataclass(frozen=True)
class Doc:
    doc_id: str
    group: str
    kind: str  # "base" or the mutation name
    text: str


def load_base_docs(path: Path) -> list[Doc]:
    docs: list[Doc] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        docs.append(
            Doc(doc_id=row["doc_id"], group=row["doc_id"], kind="base", text=row["text"])
        )
    if not docs:
        raise ValueError(f"no documents found in {path}")
    ids = [d.doc_id for d in docs]
    if len(set(ids)) != len(ids):
        raise ValueError(f"duplicate doc_id in {path}")
    return docs


def build_corpus(base_docs: list[Doc], seed: int) -> list[Doc]:
    """Base docs plus one mutant per (doc, mutation), deterministically."""
    corpus = list(base_docs)
    for doc in base_docs:
        for name, fn in MUTATIONS.items():
            rng = random.Random(f"{seed}:{doc.group}:{name}")
            mutate: Callable[[str, random.Random], str] = fn  # type: ignore[assignment]
            corpus.append(
                Doc(
                    doc_id=f"{doc.group}--{name}",
                    group=doc.group,
                    kind=name,
                    text=mutate(doc.text, rng),
                )
            )
    return corpus


def pair_key(a: str, b: str) -> tuple[str, str]:
    return (a, b) if a <= b else (b, a)


def all_pairs(docs: list[Doc]) -> list[tuple[str, str]]:
    ids = sorted(d.doc_id for d in docs)
    return [(ids[i], ids[j]) for i in range(len(ids)) for j in range(i + 1, len(ids))]


def true_duplicate_pairs(docs: list[Doc]) -> set[tuple[str, str]]:
    by_group: dict[str, list[str]] = {}
    for d in docs:
        by_group.setdefault(d.group, []).append(d.doc_id)
    pairs: set[tuple[str, str]] = set()
    for members in by_group.values():
        members = sorted(members)
        for i, a in enumerate(members):
            for b in members[i + 1 :]:
                pairs.add(pair_key(a, b))
    return pairs
