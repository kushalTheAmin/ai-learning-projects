"""Evaluate scorers as unsupported-claim detectors.

A detector flags a claim when its score falls strictly below a
threshold. Two views, both robust to the dataset's class balance:

- AUC: the probability a random unsupported claim scores below a random
  supported one, computed exactly over all pairs (ties count half).
  Pure ranking quality, no threshold at all. 0.5 is a coin flip and
  below 0.5 means the scorer ranks hallucinations ABOVE the truth.
- Operating point: the sweep tries every threshold that produces a
  distinct flagging (each unique score, plus one above the max) and
  keeps the one maximizing Youden's J = recall - false positive rate.
  Unlike best-F1 on an unsupported-heavy dataset, flag-everything
  scores J = 0, so the chosen point has to actually discriminate.
  Ties go to the lowest threshold, which flags the least.
"""

from dataclasses import dataclass

from .data import Claim, Context
from .scorers import ContextBundle, Scorer


@dataclass(frozen=True)
class ScoredClaim:
    claim: Claim
    context_id: str
    score: float


@dataclass(frozen=True)
class OperatingPoint:
    threshold: float
    precision: float
    recall: float
    false_positive_rate: float
    youden_j: float
    f1: float
    flagged: int


def score_dataset(contexts: list[Context], scorer: Scorer) -> list[ScoredClaim]:
    scored: list[ScoredClaim] = []
    for context in contexts:
        bundle = ContextBundle(context.text)
        for claim in context.claims:
            scored.append(
                ScoredClaim(
                    claim=claim,
                    context_id=context.id,
                    score=scorer(claim.text, bundle),
                )
            )
    return scored


def operating_point(scored: list[ScoredClaim], threshold: float) -> OperatingPoint:
    flagged = [s for s in scored if s.score < threshold]
    true_positives = sum(1 for s in flagged if not s.claim.supported)
    false_positives = len(flagged) - true_positives
    unsupported_total = sum(1 for s in scored if not s.claim.supported)
    supported_total = len(scored) - unsupported_total
    precision = true_positives / len(flagged) if flagged else 0.0
    recall = true_positives / unsupported_total if unsupported_total else 0.0
    false_positive_rate = (
        false_positives / supported_total if supported_total else 0.0
    )
    f1 = (
        2 * precision * recall / (precision + recall)
        if precision + recall > 0
        else 0.0
    )
    return OperatingPoint(
        threshold=threshold,
        precision=precision,
        recall=recall,
        false_positive_rate=false_positive_rate,
        youden_j=recall - false_positive_rate,
        f1=f1,
        flagged=len(flagged),
    )


def best_operating_point(scored: list[ScoredClaim]) -> OperatingPoint:
    if not scored:
        raise ValueError("cannot pick a threshold with no scored claims")
    candidates = sorted({s.score for s in scored})
    candidates.append(candidates[-1] + 1.0)
    best = operating_point(scored, candidates[0])
    for threshold in candidates[1:]:
        point = operating_point(scored, threshold)
        if point.youden_j > best.youden_j:
            best = point
    return best


def auc(scored: list[ScoredClaim]) -> float:
    """P(random unsupported claim scores below a random supported one),
    exact over all supported x unsupported pairs, ties counting 0.5."""
    supported = sorted(s.score for s in scored if s.claim.supported)
    unsupported = sorted(s.score for s in scored if not s.claim.supported)
    if not supported or not unsupported:
        raise ValueError("need both supported and unsupported claims")
    wins = 0.0
    for u in unsupported:
        for s in supported:
            if u < s:
                wins += 1.0
            elif u == s:
                wins += 0.5
    return wins / (len(supported) * len(unsupported))


def flag_rates_by_category(
    scored: list[ScoredClaim], threshold: float
) -> dict[str, tuple[int, int]]:
    """category -> (flagged, total). For unsupported categories the rate
    is recall; for supported categories it is the false-positive rate."""
    rates: dict[str, tuple[int, int]] = {}
    for s in scored:
        flagged, total = rates.get(s.claim.category, (0, 0))
        rates[s.claim.category] = (
            flagged + (1 if s.score < threshold else 0),
            total + 1,
        )
    return rates


def mean_score_by_support(scored: list[ScoredClaim]) -> tuple[float, float]:
    """(mean over supported claims, mean over unsupported claims)."""
    supported = [s.score for s in scored if s.claim.supported]
    unsupported = [s.score for s in scored if not s.claim.supported]
    if not supported or not unsupported:
        raise ValueError("need both supported and unsupported claims")
    return (
        sum(supported) / len(supported),
        sum(unsupported) / len(unsupported),
    )
