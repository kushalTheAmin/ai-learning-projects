"""Run every system over the golden set and print the measured comparison."""

from multihop.data import load_corpus, load_queries, validate
from multihop.evaluate import (
    aggregate,
    bridge_accuracy,
    drift_split,
    run_all,
    single_hop,
    two_hop,
)
from multihop.reuse import paired_bootstrap


def fmt(value: float | None) -> str:
    return "  --" if value is None else f"{value:.3f}"


def main() -> None:
    docs = load_corpus()
    queries = load_queries()
    validate(docs, queries)
    n_two = sum(1 for q in queries if q.kind == "two-hop")
    print(f"corpus: {len(docs)} docs | queries: {n_two} two-hop, {len(queries) - n_two} single-hop control")

    results = run_all(docs, queries)

    print("\ntwo-hop queries (answer doc reachable only through the bridge entity)")
    header = f"{'system':<12} {'recall@1':>9} {'recall@5':>9} {'mrr@10':>8} {'pair@5':>8} {'searches':>9}"
    print(header)
    print("-" * len(header))
    for name in ("single", "iter-append", "iter-focus", "oracle"):
        agg = aggregate(two_hop(results[name]) if name != "oracle" else results[name])
        print(
            f"{name:<12} {fmt(agg.recall1):>9} {fmt(agg.recall5):>9} "
            f"{fmt(agg.mrr):>8} {fmt(agg.pair5):>8} {agg.search_calls:>9.2f}"
        )

    single_rr = [r.rr for r in two_hop(results["single"])]
    append_rr = [r.rr for r in two_hop(results["iter-append"])]
    comparison = paired_bootstrap(append_rr, single_rr)
    print(
        f"\npaired bootstrap, iter-append vs single, answer mrr over {len(single_rr)} two-hop queries:"
        f"\n  diff {comparison.diff:+.3f} [{comparison.ci.lo:+.3f}, {comparison.ci.hi:+.3f}]"
        f" 95% ci, p(diff <= 0) = {comparison.p_le_zero:.4f}"
    )

    print(f"\nbridge extraction (tf*idf novel terms, top 3): gold bridge covered on "
          f"{fmt(bridge_accuracy(results['iter-append']))} of two-hop queries")

    print("\nquery drift, iter-append: answer mrr conditioned on what hop 1 retrieved")
    for label, (count, value) in drift_split(results["iter-append"]).items():
        print(f"  {label:<26} n={count:<3} mrr {fmt(value) if count else '  --'}")

    print("\nsingle-hop control queries (pipeline runs blind, no router says these need one hop)")
    for name in ("single", "iter-append", "iter-focus"):
        agg = aggregate(single_hop(results[name]))
        print(f"  {name:<12} recall@1 {fmt(agg.recall1)}  mrr@10 {fmt(agg.mrr)}  searches {agg.search_calls:.2f}")

    print("\nper-query detail, two-hop, iter-append (misses first)")
    detail = sorted(two_hop(results["iter-append"]), key=lambda r: (r.rr, r.query.id))
    for r in detail:
        hop1 = "gold" if r.hop1_top1_correct else "WRONG"
        bridge = "hit " if r.bridge_hit else "MISS"
        print(
            f"  {r.query.id}  rr {r.rr:.3f}  hop1-top1 {hop1}  bridge {bridge}"
            f"  extracted {r.retrieval.bridge_terms}"
        )


if __name__ == "__main__":
    main()
