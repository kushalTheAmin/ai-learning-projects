"""Score every claim in the committed dataset with every method, sweep
detection thresholds, and print how each method's best operating point
breaks down by failure category. Deterministic: no randomness anywhere,
same output every run."""

from pathlib import Path

from groundedness.data import SUPPORTED_CATEGORIES, load_contexts
from groundedness.evaluate import (
    auc,
    best_operating_point,
    flag_rates_by_category,
    mean_score_by_support,
    score_dataset,
)
from groundedness.scorers import METHODS

DATA = Path(__file__).parent / "data" / "contexts.jsonl"

# supported categories first, then unsupported, hardest last
CATEGORY_ORDER = [
    "verbatim",
    "paraphrase",
    "synthesis",
    "negated_paraphrase",
    "fabricated",
    "outside_knowledge",
    "number_swap",
    "entity_swap",
    "negation_flip",
    "antonym_flip",
]


def main() -> None:
    contexts = load_contexts(DATA)
    claims = [claim for context in contexts for claim in context.claims]
    supported = sum(1 for claim in claims if claim.supported)
    print("groundedness scoring: flagging claims the context does not support")
    print()
    print(
        f"dataset: {len(contexts)} contexts, {len(claims)} claims "
        f"({supported} supported, {len(claims) - supported} unsupported)"
    )
    print()

    scored_by_method = {
        name: score_dataset(contexts, scorer) for name, scorer in METHODS.items()
    }
    best_by_method = {
        name: best_operating_point(scored)
        for name, scored in scored_by_method.items()
    }

    print("ranking quality and best operating point per method")
    print("(flag when score < threshold; threshold picked by max Youden J)")
    print(
        f"{'method':<16} {'AUC':>6} {'mean sup':>9} {'mean unsup':>10} "
        f"{'thr':>6} {'prec':>6} {'recall':>7} {'FPR':>6} {'J':>6}"
    )
    for name, scored in scored_by_method.items():
        point = best_by_method[name]
        mean_sup, mean_unsup = mean_score_by_support(scored)
        print(
            f"{name:<16} {auc(scored):>6.3f} {mean_sup:>9.3f} "
            f"{mean_unsup:>10.3f} {point.threshold:>6.3f} "
            f"{point.precision:>6.3f} {point.recall:>7.3f} "
            f"{point.false_positive_rate:>6.3f} {point.youden_j:>6.3f}"
        )
    print()

    print("flag rate by category at each method's best threshold")
    print("(unsupported rows: recall, want 1.00. supported rows: false")
    print("positives, want 0.00)")
    names = list(METHODS)
    print(f"{'category':<24} {'n':>3} " + " ".join(f"{n:>15}" for n in names))
    for category in CATEGORY_ORDER:
        cells = []
        total = 0
        for name in names:
            rates = flag_rates_by_category(
                scored_by_method[name], best_by_method[name].threshold
            )
            flagged, total = rates[category]
            cells.append(f"{flagged:>2}/{total:<2} ({flagged / total:.2f})")
        label = "sup" if category in SUPPORTED_CATEGORIES else "unsup"
        print(
            f"{category:<18} {label:<5} {total:>3} "
            + " ".join(f"{cell:>15}" for cell in cells)
        )


if __name__ == "__main__":
    main()
