"""Scripted stand-in for the generation step of HyDE.

Real HyDE asks a model to write a hypothetical answer document and searches
with that text, betting that a fluent answer shares vocabulary with the
real answer doc even when the question does not. No model runs here.
Instead each query has one authored answer (written from the question text
alone), and a hallucination knob replaces it with the authored answer to a
DIFFERENT question: fluent, confident, on the wrong subject — the actual
failure mode of generating an answer you do not know.

Draws are per-query and nested: a query that hallucinates at rate 0.1
still hallucinates at 0.5, so sweeping the rate moves one variable. The
wrong answer is the next query's in sorted-id order, fixed across rates,
so a query's failure text never changes, only whether it fires.

Which queries fire is the rate-quantile of the per-query scores rather than
an independent coin per query: exactly round(rate * n) of them hallucinate,
so a sweep point sits at the rate it is labelled with. An independent coin
gives the rate only in expectation, and on 40 queries that is not close
enough to reason from — rate 0.1 fired 7 and rate 0.5 fired 15. Ordering by
score keeps the nesting; the seed still picks which queries fire.
"""

import hashlib
import math
from dataclasses import dataclass

GENERIC_ANSWER = (
    "there are several ways to approach this and the best choice depends on "
    "your setup. start with the documentation, follow best practices, test "
    "the change in a safe environment, and monitor the results before "
    "rolling it out widely."
)


@dataclass(frozen=True)
class Hypothetical:
    text: str
    hallucinated: bool
    source_query_id: str  # whose authored answer this is


def _unit_draw(seed: int, query_id: str) -> float:
    digest = hashlib.sha256(f"{seed}:{query_id}".encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big") / 2**64


class ScriptedHyde:
    def __init__(
        self,
        hypotheticals: dict[str, str],
        hallucination_rate: float,
        seed: int = 0,
    ):
        if not 0.0 <= hallucination_rate <= 1.0:
            raise ValueError(
                f"hallucination_rate must be in [0, 1], got {hallucination_rate}"
            )
        if len(hypotheticals) < 2:
            raise ValueError("need at least 2 hypotheticals to have a wrong answer")
        self.hypotheticals = dict(hypotheticals)
        self.hallucination_rate = hallucination_rate
        self.seed = seed
        ordered = sorted(hypotheticals)
        self._wrong_source = {
            query_id: ordered[(i + 1) % len(ordered)]
            for i, query_id in enumerate(ordered)
        }
        by_draw = sorted(ordered, key=lambda query_id: (_unit_draw(seed, query_id), query_id))
        count = math.floor(hallucination_rate * len(ordered) + 0.5)  # half up, not banker's
        self._hallucinating = frozenset(by_draw[:count])

    def generate(self, query_id: str) -> Hypothetical:
        if query_id not in self.hypotheticals:
            raise KeyError(f"no authored hypothetical for query {query_id!r}")
        hallucinated = query_id in self._hallucinating
        source = self._wrong_source[query_id] if hallucinated else query_id
        return Hypothetical(
            text=self.hypotheticals[source],
            hallucinated=hallucinated,
            source_query_id=source,
        )
