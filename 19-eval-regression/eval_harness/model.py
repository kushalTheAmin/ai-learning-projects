"""Scripted model versions with known ground truth.

Each version is a per-category skill table: the probability of
answering a category's items correctly, shifted by the item's own
difficulty offset. An eval run draws each outcome from a rng seeded by
(version, item id, eval seed), so a run is fully deterministic given
its seed while two runs with different seeds model the rerun noise a
sampled real model produces. On a wrong outcome the model emits the
item's distractor, so the harness scores real answer strings.

The four versions encode the four situations a regression gate faces:
an unchanged model (noise only), a slice regression sized to vanish
from the aggregate, a small uniform drift, and a true improvement.
"""

import hashlib
import random
from dataclasses import dataclass
from types import MappingProxyType
from typing import Mapping

from .data import CATEGORIES, GoldenItem

P_MIN, P_MAX = 0.02, 0.995


def stable_u64(*parts: str) -> int:
    """Deterministic 64-bit seed from strings, stable across processes."""
    digest = hashlib.sha256("|".join(parts).encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big")


@dataclass(frozen=True)
class ScriptedModel:
    name: str
    skills: Mapping[str, float]  # category -> base p(correct)

    def __post_init__(self) -> None:
        missing = [c for c in CATEGORIES if c not in self.skills]
        if missing:
            raise ValueError(f"model {self.name} missing skills for {missing}")
        for category, skill in self.skills.items():
            if not 0.0 <= skill <= 1.0:
                raise ValueError(
                    f"model {self.name} skill for {category} out of [0, 1]: {skill}"
                )

    def p_correct(self, item: GoldenItem) -> float:
        p = self.skills[item.category] + item.difficulty
        return min(max(p, P_MIN), P_MAX)

    def answer(self, item: GoldenItem, eval_seed: int) -> str:
        rng = random.Random(stable_u64(self.name, item.item_id, str(eval_seed)))
        if rng.random() < self.p_correct(item):
            return item.expected
        return item.distractor


def _model(name: str, base: dict[str, float], shift: dict[str, float]) -> ScriptedModel:
    skills = {c: base[c] + shift.get(c, 0.0) for c in base}
    return ScriptedModel(name=name, skills=MappingProxyType(skills))


_BASE_SKILLS = {
    "arithmetic": 0.92,
    "date": 0.86,
    "entity": 0.88,
    "format": 0.84,
    "negation": 0.78,
    "unit": 0.90,
}

BASELINE = _model("baseline-1.0", _BASE_SKILLS, {})

# date drops 0.24 while the other five categories gain 0.048 each, so the
# unclipped mean over categories is unchanged: the aggregate metric is
# blind to this change by construction.
MASKED_REGRESSION = _model(
    "masked-2.0",
    _BASE_SKILLS,
    {
        "date": -0.24,
        "arithmetic": 0.048,
        "entity": 0.048,
        "format": 0.048,
        "negation": 0.048,
        "unit": 0.048,
    },
)

DRIFT = _model("drift-1.1", _BASE_SKILLS, {c: -0.03 for c in _BASE_SKILLS})

IMPROVED = _model("improved-3.0", _BASE_SKILLS, {c: 0.04 for c in _BASE_SKILLS})

VERSIONS = {m.name: m for m in (BASELINE, MASKED_REGRESSION, DRIFT, IMPROVED)}
