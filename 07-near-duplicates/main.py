"""Near-duplicate detection: MinHash + LSH vs SimHash, measured.

Builds a corpus of committed base documents plus seeded mutants, computes
exact Jaccard ground truth over every pair, then measures how well each
approximate method recovers the labeled duplicate pairs and what it costs.
"""

from __future__ import annotations

from pathlib import Path

from neardup.corpus import (
    Doc,
    all_pairs,
    build_corpus,
    load_base_docs,
    pair_key,
    true_duplicate_pairs,
)
from neardup.evaluate import max_absolute_error, mean_absolute_error, score_pairs
from neardup.lsh import candidate_pairs, halfway_threshold
from neardup.minhash import MinHasher, estimate_jaccard
from neardup.mutations import MUTATIONS
from neardup.shingles import hashed_shingles, jaccard, word_shingles
from neardup.simhash import hamming_distance, simhash

DATA_PATH = Path(__file__).parent / "data" / "docs.jsonl"
CORPUS_SEED = 42
MINHASH_SEED = 7
SIGNATURE_K = 128
K_SWEEP = [8, 16, 32, 64, 128]
BAND_CONFIGS = [(64, 2), (32, 4), (16, 8), (8, 16)]
JACCARD_SWEEP = [0.2, 0.3, 0.4, 0.5, 0.6]
HAMMING_SWEEP = [2, 4, 6, 8, 12, 16, 20]
TUNED_BANDS, TUNED_ROWS = 64, 2
MISTUNED_BANDS, MISTUNED_ROWS = 32, 4


def pair_kind(docs_by_id: dict[str, Doc], pair: tuple[str, str]) -> str:
    a, b = docs_by_id[pair[0]], docs_by_id[pair[1]]
    if a.kind == "base":
        return b.kind
    if b.kind == "base":
        return a.kind
    return "mutant-mutant"


def topic_relation(docs_by_id: dict[str, Doc], pair: tuple[str, str]) -> str:
    """Whether a pair's two documents were written about the same topic."""
    a, b = docs_by_id[pair[0]], docs_by_id[pair[1]]
    return "same-topic" if a.topic == b.topic else "cross-topic"


def recall_by_kind(
    docs_by_id: dict[str, Doc],
    predicted: set[tuple[str, str]],
    truth: set[tuple[str, str]],
) -> dict[str, tuple[int, int]]:
    out: dict[str, tuple[int, int]] = {}
    for pair in sorted(truth):
        kind = pair_kind(docs_by_id, pair)
        hit, total = out.get(kind, (0, 0))
        out[kind] = (hit + (1 if pair in predicted else 0), total + 1)
    return out


def print_kind_recall(label: str, by_kind: dict[str, tuple[int, int]]) -> None:
    print(f"  recall by pair kind, {label}:")
    kinds = [*MUTATIONS.keys(), "mutant-mutant"]
    for kind in kinds:
        hit, total = by_kind[kind]
        print(f"    {kind:>14}: {hit:>3}/{total:<3} ({hit / total:.3f})")


def main() -> None:
    base_docs = load_base_docs(DATA_PATH)
    docs = build_corpus(base_docs, seed=CORPUS_SEED)
    docs_by_id = {d.doc_id: d for d in docs}
    truth = true_duplicate_pairs(docs)
    pairs = all_pairs(docs)

    print("near-duplicate detection: minhash + lsh vs simhash")
    print(
        f"corpus: {len(base_docs)} base docs x {len(MUTATIONS)} mutations "
        f"-> {len(docs)} docs, {len(pairs)} pairs, "
        f"{len(truth)} true duplicate pairs"
    )

    shingle_sets = {d.doc_id: word_shingles(d.text) for d in docs}
    hashed = {d.doc_id: hashed_shingles(d.text) for d in docs}
    exact = {p: jaccard(shingle_sets[p[0]], shingle_sets[p[1]]) for p in pairs}

    print("\n== separability: exact jaccard on 3-word shingles ==")
    for name in MUTATIONS:
        vals = sorted(
            exact[pair_key(d.group, d.doc_id)] for d in docs if d.kind == name
        )
        mean = sum(vals) / len(vals)
        print(
            f"  base vs {name:>8}: mean {mean:.3f}  "
            f"min {vals[0]:.3f}  max {vals[-1]:.3f}"
        )
    cross = sorted(
        exact[p]
        for p in truth
        if docs_by_id[p[0]].kind != "base" and docs_by_id[p[1]].kind != "base"
    )
    print(
        f"  mutant vs mutant : mean {sum(cross) / len(cross):.3f}  "
        f"min {cross[0]:.3f}  max {cross[-1]:.3f}   ({len(cross)} pairs)"
    )
    nondup = [(exact[p], p) for p in pairs if p not in truth]
    hardest_val, hardest_pair = max(nondup)
    ha, hb = docs_by_id[hardest_pair[0]], docs_by_id[hardest_pair[1]]
    relation = topic_relation(docs_by_id, hardest_pair)
    detail = ha.topic if relation == "same-topic" else f"{ha.topic} / {hb.topic}"
    print(
        f"  hardest non-duplicate: {hardest_pair[0]} vs {hardest_pair[1]} "
        f"at {hardest_val:.3f} ({relation}: {detail})"
    )
    nd_same = [(v, p) for v, p in nondup if topic_relation(docs_by_id, p) == "same-topic"]
    nd_cross = [(v, p) for v, p in nondup if topic_relation(docs_by_id, p) == "cross-topic"]
    same_val, same_pair = max(nd_same)
    print(
        f"  hardest same-topic non-duplicate: {same_pair[0]} vs {same_pair[1]} "
        f"at {same_val:.3f} ({docs_by_id[same_pair[0]].topic})"
    )
    print(
        f"  non-duplicate means: same-topic "
        f"{sum(v for v, _ in nd_same) / len(nd_same):.4f} over {len(nd_same)} pairs, "
        f"cross-topic {sum(v for v, _ in nd_cross) / len(nd_cross):.4f} "
        f"over {len(nd_cross)}"
    )

    print("\n== brute-force exact jaccard, threshold sweep ==")
    print(f"  ({len(pairs)} full set comparisons)")
    best_t, best_f1 = JACCARD_SWEEP[0], -1.0
    for t in JACCARD_SWEEP:
        predicted = {p for p in pairs if exact[p] >= t}
        s = score_pairs(predicted, truth)
        print(
            f"  t={t:.1f}: precision {s.precision:.3f}  recall {s.recall:.3f}  "
            f"f1 {s.f1:.3f}  ({s.predicted} predicted)"
        )
        if s.f1 > best_f1:
            best_t, best_f1 = t, s.f1
    print(f"  best f1 at t={best_t:.1f}; used as the verification threshold below")

    print(f"\n== minhash estimator accuracy (seed {MINHASH_SEED}) ==")
    hasher = MinHasher(SIGNATURE_K, seed=MINHASH_SEED)
    signatures = {doc_id: hasher.signature(h) for doc_id, h in hashed.items()}
    print("  error of the signature estimate vs exact jaccard:")
    for k in K_SWEEP:
        errs = [
            (estimate_jaccard(signatures[a], signatures[b], k), exact[(a, b)])
            for a, b in pairs
        ]
        dup_errs = [
            (estimate_jaccard(signatures[a], signatures[b], k), exact[(a, b)])
            for a, b in sorted(truth)
        ]
        print(
            f"  k={k:>3}: mean abs err {mean_absolute_error(errs):.4f} all pairs, "
            f"{mean_absolute_error(dup_errs):.4f} duplicate pairs  "
            f"(max {max_absolute_error(errs):.4f})"
        )

    print(f"\n== lsh banding sweep over k={SIGNATURE_K} signatures ==")
    for bands, rows in BAND_CONFIGS:
        cands = candidate_pairs(signatures, bands, rows)
        s = score_pairs(cands, truth)
        frac = len(cands) / len(pairs)
        print(
            f"  b={bands:>2} r={rows:>2}: 50% collision at s={halfway_threshold(bands, rows):.3f}  "
            f"candidates {len(cands):>4} ({frac:.1%} of pairs)  "
            f"dup recall {s.recall:.3f}  precision {s.precision:.3f}"
        )

    print(
        f"\n== pipeline: lsh candidates verified with exact jaccard >= {best_t:.1f} =="
    )
    brute = {p for p in pairs if exact[p] >= best_t}
    sb = score_pairs(brute, truth)
    tuned_f1 = 0.0
    for bands, rows in [(TUNED_BANDS, TUNED_ROWS), (MISTUNED_BANDS, MISTUNED_ROWS)]:
        cands = candidate_pairs(signatures, bands, rows)
        verified = {p for p in cands if exact[p] >= best_t}
        s = score_pairs(verified, truth)
        print(
            f"  b={bands} r={rows}: precision {s.precision:.3f}  "
            f"recall {s.recall:.3f}  f1 {s.f1:.3f}  "
            f"with {len(cands)} verifications "
            f"({len(cands) / len(pairs):.1%} of brute force's {len(pairs)})"
        )
        if (bands, rows) == (TUNED_BANDS, TUNED_ROWS):
            tuned_f1 = s.f1
        else:
            missed = sorted(brute - cands)
            print(
                f"  the mistuned banding never sees {len(missed)} of brute "
                f"force's {len(brute)} pairs: its 50% collision threshold "
                f"({halfway_threshold(bands, rows):.3f}) sits above the "
                f"lowest duplicate jaccard ({cross[0]:.3f})"
            )
            print_kind_recall(
                f"mistuned b={bands} r={rows}",
                recall_by_kind(docs_by_id, verified, truth),
            )
    print(
        f"  brute force: precision {sb.precision:.3f}  recall {sb.recall:.3f}  "
        f"f1 {sb.f1:.3f}  with {len(pairs)} verifications"
    )

    print("\n== simhash (64-bit), hamming distance sweep ==")
    prints = {doc_id: simhash(s) for doc_id, s in shingle_sets.items()}
    dists = {p: hamming_distance(prints[p[0]], prints[p[1]]) for p in pairs}
    dup_d = [dists[p] for p in sorted(truth)]
    non_d = [dists[p] for p in pairs if p not in truth]
    print(
        f"  duplicate pairs: mean distance {sum(dup_d) / len(dup_d):.1f}  "
        f"non-duplicates: mean {sum(non_d) / len(non_d):.1f}  "
        f"min {min(non_d)}"
    )
    best_d, best_df1 = HAMMING_SWEEP[0], -1.0
    for d in HAMMING_SWEEP:
        predicted = {p for p in pairs if dists[p] <= d}
        sd = score_pairs(predicted, truth)
        print(
            f"  d<={d:>2}: precision {sd.precision:.3f}  recall {sd.recall:.3f}  "
            f"f1 {sd.f1:.3f}  ({sd.predicted} predicted)"
        )
        if sd.f1 > best_df1:
            best_d, best_df1 = d, sd.f1
    predicted = {p for p in pairs if dists[p] <= best_d}
    print_kind_recall(
        f"simhash d<={best_d}", recall_by_kind(docs_by_id, predicted, truth)
    )

    print("\n== head to head at each method's best operating point ==")
    print(
        f"  minhash lsh + verify (b={TUNED_BANDS} r={TUNED_ROWS}, "
        f"t={best_t:.1f}): f1 {tuned_f1:.3f}"
    )
    print(f"  simhash (d<={best_d}): f1 {best_df1:.3f}")
    print(f"  brute-force exact jaccard (t={best_t:.1f}): f1 {sb.f1:.3f}")


if __name__ == "__main__":
    main()
