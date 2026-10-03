"""Run every query-rewriting system over the golden set and print the
measured comparison."""

from query_rewriting.data import load_corpus, load_hypotheticals, load_queries, validate
from query_rewriting.evaluate import (
    aggregate,
    by_category,
    paired_rrs,
    run_generic_append,
    run_hyde,
    run_prf,
    run_raw,
)
from query_rewriting.generator import ScriptedHyde
from query_rewriting.reuse import BM25Index, mean, paired_bootstrap

SEED = 7
SWEEP_RATES = (0.0, 0.1, 0.25, 0.5, 1.0)
PRF_DEPTHS = (1, 3, 5, 10)
CROSSING_SEEDS = tuple(range(10))
BAND_RATE = 0.25


def first_rate_under_raw(
    index: BM25Index,
    queries: list,
    hypotheticals: dict[str, str],
    mode: str,
    raw_mrr: float,
    seed: int,
) -> float | None:
    """The lowest hallucination rate whose mrr falls under the raw query,
    swept one query at a time. None when no rate does.

    The sweep fires exactly round(rate * n) queries, so a point sits at the
    rate it is labelled with — but *which* queries sit in the first k is the
    seed's, and that is what decides where a mode stops paying. So this is
    one draw's crossing, not the mechanism's, and it is only worth reading
    as a band over seeds.
    """
    n = len(hypotheticals)
    for count in range(n + 1):
        hyde = ScriptedHyde(hypotheticals, hallucination_rate=count / n, seed=seed)
        if aggregate(run_hyde(index, queries, hyde, mode)).mrr < raw_mrr:
            return count / n
    return None


def main() -> None:
    docs = load_corpus()
    queries = load_queries()
    hypotheticals = load_hypotheticals()
    validate(docs, queries, hypotheticals)
    index = BM25Index(docs)
    n_keyword = len([q for q in queries if q.category == "keyword"])
    print(
        f"corpus: {len(docs)} docs (03's dataset) | queries: {len(queries)} "
        f"({n_keyword} keyword, {len(queries) - n_keyword} paraphrase)"
    )

    honest = ScriptedHyde(hypotheticals, hallucination_rate=0.0, seed=SEED)
    systems = {
        "raw": run_raw(index, queries),
        "prf-5": run_prf(docs, index, queries, max_terms=5),
        "hyde-append": run_hyde(index, queries, honest, "append"),
        "hyde-replace": run_hyde(index, queries, honest, "replace"),
        "generic-append": run_generic_append(index, queries),
    }

    print("\nall 40 queries, then mrr@10 split by query category")
    header = (
        f"{'system':<15} {'recall@1':>9} {'recall@5':>9} {'mrr@10':>8} "
        f"{'mrr kw':>8} {'mrr para':>9} {'+terms':>7}"
    )
    print(header)
    print("-" * len(header))
    for name, outcomes in systems.items():
        agg = aggregate(outcomes)
        kw = aggregate(by_category(outcomes, "keyword"))
        para = aggregate(by_category(outcomes, "paraphrase"))
        print(
            f"{name:<15} {agg.recall1:>9.3f} {agg.recall5:>9.3f} {agg.mrr:>8.3f} "
            f"{kw.mrr:>8.3f} {para.mrr:>9.3f} {agg.added_terms:>7.1f}"
        )

    print("\npaired bootstrap vs raw, per-query rr@10, 10000 resamples, 95% ci")
    for name in ("prf-5", "hyde-append", "hyde-replace", "generic-append"):
        rrs_system, rrs_raw = paired_rrs(systems[name], systems["raw"])
        comparison = paired_bootstrap(rrs_system, rrs_raw)
        print(
            f"  {name:<15} diff {comparison.diff:+.3f} "
            f"[{comparison.ci.lo:+.3f}, {comparison.ci.hi:+.3f}] "
            f"p(diff <= 0) = {comparison.p_le_zero:.4f}"
        )

    print("\nprf depth sweep (terms appended from the first search's top doc)")
    for depth in PRF_DEPTHS:
        outcomes = run_prf(docs, index, queries, max_terms=depth)
        agg = aggregate(outcomes)
        para = aggregate(by_category(outcomes, "paraphrase"))
        print(
            f"  prf-{depth:<3} mrr@10 {agg.mrr:.3f}  paraphrase {para.mrr:.3f}  "
            f"+terms {agg.added_terms:.1f}"
        )

    print("\nprf-5 delta rr vs raw, split by whether the expansion doc was a gold doc")
    raw_rr = {outcome.query_id: outcome.rr for outcome in systems["raw"]}
    for label, wanted in (("expansion doc relevant", True), ("expansion doc wrong", False)):
        group = [o for o in systems["prf-5"] if o.prf_source_relevant is wanted]
        deltas = [o.rr - raw_rr[o.query_id] for o in group]
        shown = f"{mean(deltas):+.3f}" if deltas else "   --"
        print(f"  {label:<24} n={len(group):<3} mean delta rr {shown}")

    raw_mrr = aggregate(systems["raw"]).mrr
    print(
        "\nhallucination sweep (authored answer swapped for a confidently wrong one)"
        f"\n{'rate':>6} {'n_halluc':>9} {'append mrr':>11} {'replace mrr':>12} "
        f"{'append mrr (halluc only)':>25}"
    )
    for rate in SWEEP_RATES:
        hyde = ScriptedHyde(hypotheticals, hallucination_rate=rate, seed=SEED)
        append_outcomes = run_hyde(index, queries, hyde, "append")
        replace_outcomes = run_hyde(index, queries, hyde, "replace")
        hallucinated = [o for o in append_outcomes if o.hallucinated]
        halluc_mrr = f"{aggregate(hallucinated).mrr:>25.3f}" if hallucinated else f"{'--':>25}"
        print(
            f"{rate:>6.2f} {len(hallucinated):>9} "
            f"{aggregate(append_outcomes).mrr:>11.3f} "
            f"{aggregate(replace_outcomes).mrr:>12.3f} {halluc_mrr}"
        )
    print(f"  (raw mrr@10 for reference: {raw_mrr:.3f})")

    print(
        f"\nthe crossing is one draw, so both curves over {len(CROSSING_SEEDS)} "
        "hallucination seeds (first rate whose mrr falls under raw)"
        f"\n{'seed':>6} {'append mrr @' + format(BAND_RATE, '.2f'):>17} "
        f"{'append under raw':>17} {'replace under raw':>18}"
    )
    band_mrrs: list[float] = []
    crossings: dict[str, list[float]] = {"append": [], "replace": []}
    for seed in CROSSING_SEEDS:
        hyde = ScriptedHyde(hypotheticals, hallucination_rate=BAND_RATE, seed=seed)
        band_mrrs.append(aggregate(run_hyde(index, queries, hyde, "append")).mrr)
        for mode in ("append", "replace"):
            crossings[mode].append(
                first_rate_under_raw(
                    index, queries, hypotheticals, mode, raw_mrr, seed
                )
            )
        print(
            f"{seed:>6} {band_mrrs[-1]:>17.3f} "
            f"{crossings['append'][-1]:>17.1%} {crossings['replace'][-1]:>18.1%}"
        )

    def band(low: float, high: float, fmt: str, width: int) -> str:
        return f"{format(low, fmt) + ' - ' + format(high, fmt):>{width}}"

    print(
        f"{'band':>6} {band(min(band_mrrs), max(band_mrrs), '.3f', 17)} "
        f"{band(min(crossings['append']), max(crossings['append']), '.1%', 17)} "
        f"{band(min(crossings['replace']), max(crossings['replace']), '.1%', 18)}"
    )
    under = sum(1 for value in band_mrrs if value < raw_mrr)
    gaps = [
        round((append - replace) * len(hypotheticals))
        for append, replace in zip(crossings["append"], crossings["replace"])
    ]
    print(
        f"  ({under} of {len(CROSSING_SEEDS)} draws put append under raw at "
        f"{BAND_RATE:.2f}; append outlives replace by {min(gaps)} to {max(gaps)} "
        "queries on every draw)"
    )

    print("\nbiggest per-query moves, hyde-append (rate 0) vs raw")
    moves = sorted(
        systems["hyde-append"],
        key=lambda o: (o.rr - raw_rr[o.query_id], o.query_id),
    )
    for outcome in list(reversed(moves))[:3] + moves[:3]:
        delta = outcome.rr - raw_rr[outcome.query_id]
        print(
            f"  {outcome.query_id} ({outcome.category:<10}) rr "
            f"{raw_rr[outcome.query_id]:.3f} -> {outcome.rr:.3f} ({delta:+.3f})"
        )


if __name__ == "__main__":
    main()
