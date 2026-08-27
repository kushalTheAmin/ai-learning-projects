"""End-to-end checks on the committed corpus, pinning the headline results."""

from pathlib import Path

import main as entry
from neardup.corpus import build_corpus, load_base_docs, true_duplicate_pairs
from neardup.evaluate import mean_absolute_error
from neardup.lsh import candidate_pairs
from neardup.minhash import MinHasher, estimate_jaccard
from neardup.shingles import hashed_shingles, jaccard, word_shingles
from neardup.simhash import hamming_distance, simhash

DATA_PATH = Path(__file__).parent.parent / "data" / "docs.jsonl"


def build():
    docs = build_corpus(load_base_docs(DATA_PATH), seed=entry.CORPUS_SEED)
    truth = true_duplicate_pairs(docs)
    return docs, truth


class TestHeadlineResults:
    def test_tuned_lsh_candidates_equal_truth_exactly(self):
        # The b=64 r=2 banding recovers precisely the 360 labeled pairs:
        # recall 1.0 and precision 1.0, the headline number in the readme.
        docs, truth = build()
        hasher = MinHasher(entry.SIGNATURE_K, seed=entry.MINHASH_SEED)
        sigs = {d.doc_id: hasher.signature(hashed_shingles(d.text)) for d in docs}
        assert candidate_pairs(sigs, entry.TUNED_BANDS, entry.TUNED_ROWS) == truth

    def test_exact_jaccard_separates_at_020(self):
        # every duplicate pair sits at or above 0.2, every non-duplicate below
        docs, truth = build()
        shingle_sets = {d.doc_id: word_shingles(d.text) for d in docs}
        from neardup.corpus import all_pairs

        for a, b in all_pairs(docs):
            j = jaccard(shingle_sets[a], shingle_sets[b])
            if (a, b) in truth:
                assert j >= 0.2, (a, b, j)
            else:
                assert j < 0.2, (a, b, j)

    def test_minhash_duplicate_error_shrinks_with_k(self):
        docs, truth = build()
        shingle_sets = {d.doc_id: word_shingles(d.text) for d in docs}
        hasher = MinHasher(entry.SIGNATURE_K, seed=entry.MINHASH_SEED)
        sigs = {d.doc_id: hasher.signature(hashed_shingles(d.text)) for d in docs}
        maes = []
        for k in entry.K_SWEEP:
            errs = [
                (
                    estimate_jaccard(sigs[a], sigs[b], k),
                    jaccard(shingle_sets[a], shingle_sets[b]),
                )
                for a, b in sorted(truth)
            ]
            maes.append(mean_absolute_error(errs))
        assert maes == sorted(maes, reverse=True)
        assert maes[-1] < 0.05

    def test_simhash_separates_on_average_but_overlaps(self):
        docs, truth = build()
        prints = {d.doc_id: simhash(word_shingles(d.text)) for d in docs}
        from neardup.corpus import all_pairs

        dup, non = [], []
        for a, b in all_pairs(docs):
            d = hamming_distance(prints[a], prints[b])
            (dup if (a, b) in truth else non).append(d)
        assert sum(dup) / len(dup) < sum(non) / len(non)
        # the distributions overlap: the widest duplicates sit past the
        # nearest non-duplicates, which is why simhash cannot reach f1 1.0
        assert max(dup) > min(non)


class TestEntryPoint:
    def test_full_run_prints_pinned_numbers(self, capsys):
        entry.main()
        out = capsys.readouterr().out
        assert "144 docs, 10296 pairs, 360 true duplicate pairs" in out
        assert "t=0.2: precision 1.000  recall 1.000  f1 1.000" in out
        assert (
            "b=64 r=2: precision 1.000  recall 1.000  f1 1.000  "
            "with 360 verifications" in out
        )
        assert "brute force: precision 1.000  recall 1.000" in out
        assert "simhash" in out
        assert "head to head" in out
