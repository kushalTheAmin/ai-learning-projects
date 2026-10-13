"""SimHash's overlapping hamming tails cost candidates, not f1.

The head to head published "minhash lsh + verify 1.000, simhash 0.942" and
read the gap as a ceiling the tails impose on the fingerprint. The two sides
were not the same pipeline: minhash's number is a candidate set handed to an
exact-jaccard verdict, simhash's is the sketch issuing verdicts by itself.
The reason given for the asymmetry - that simhash "has no verification story
of its own (the fingerprint cannot re-derive similarity, you need the
original shingles anyway)" - is true of the banding too, which verifies off
the same original shingle sets.

Verified the same way, simhash reaches f1 1.000 at d<=31, the radius holding
the widest duplicate pair, and 0.966 at the banding's own verification
budget. What the overlap costs is the shortlist: 5041 verifications against
360, 14x, to land on the same verdicts.
"""

from pathlib import Path

import pytest

import main as entry
from neardup.corpus import all_pairs, build_corpus, load_base_docs, true_duplicate_pairs
from neardup.evaluate import score_pairs
from neardup.lsh import candidate_pairs
from neardup.minhash import MinHasher
from neardup.shingles import hashed_shingles, jaccard, word_shingles
from neardup.simhash import hamming_distance, simhash

ROOT = Path(__file__).parent.parent
DATA_PATH = ROOT / "data" / "docs.jsonl"
THRESHOLD = 0.2


@pytest.fixture(scope="module")
def measured():
    docs = build_corpus(load_base_docs(DATA_PATH), seed=entry.CORPUS_SEED)
    truth = true_duplicate_pairs(docs)
    pairs = all_pairs(docs)
    shingles = {d.doc_id: word_shingles(d.text) for d in docs}
    exact = {p: jaccard(shingles[p[0]], shingles[p[1]]) for p in pairs}
    prints = {d.doc_id: simhash(shingles[d.doc_id]) for d in docs}
    dists = {p: hamming_distance(prints[p[0]], prints[p[1]]) for p in pairs}
    hasher = MinHasher(entry.SIGNATURE_K, seed=entry.MINHASH_SEED)
    sigs = {d.doc_id: hasher.signature(hashed_shingles(d.text)) for d in docs}
    banding = candidate_pairs(sigs, entry.TUNED_BANDS, entry.TUNED_ROWS)
    return {
        "truth": truth,
        "pairs": pairs,
        "exact": exact,
        "dists": dists,
        "banding": banding,
    }


def verified(measured, d):
    """Score simhash's d-radius candidates after the exact-jaccard verdict."""
    cands = {p for p in measured["pairs"] if measured["dists"][p] <= d}
    keep = {p for p in cands if measured["exact"][p] >= THRESHOLD}
    return len(cands), score_pairs(keep, measured["truth"])


def normalized(text: str) -> str:
    return " ".join(text.split())


def row_for(key: str, path: Path, section: str | None = None) -> str:
    """The one table row for `key`, optionally scoped to a `## ` section."""
    lines = path.read_text(encoding="utf-8").splitlines()
    if section is not None:
        start = lines.index(section)
        end = next(
            (i for i in range(start + 1, len(lines)) if lines[i].startswith("## ")),
            len(lines),
        )
        lines = lines[start:end]
    rows = [line for line in lines if line.startswith(f"| {key} ")]
    assert len(rows) == 1, f"expected one {key!r} row in {path.name}, got {len(rows)}"
    return rows[0]


class TestTheOverlapIsReal:
    def test_the_widest_duplicate_sits_past_the_nearest_non_duplicate(self, measured):
        dists, truth = measured["dists"], measured["truth"]
        dup = [dists[p] for p in truth]
        non = [dists[p] for p in measured["pairs"] if p not in truth]
        assert max(dup) == 31
        assert min(non) == 19
        assert max(dup) > min(non)

    def test_the_sketch_alone_still_tops_out_at_0_942(self, measured):
        # the unverified reading is unchanged - it is only the gap's cause
        # that was wrong, not this number.
        dists, truth, pairs = measured["dists"], measured["truth"], measured["pairs"]
        best = max(
            (score_pairs({p for p in pairs if dists[p] <= d}, truth).f1, d)
            for d in entry.HAMMING_SWEEP
        )
        assert best[1] == 20
        assert best[0] == pytest.approx(0.942, abs=5e-4)


class TestVerificationRemovesTheCeiling:
    def test_verification_never_costs_precision_at_any_radius(self, measured):
        # every non-duplicate sits below the threshold, so the verdict
        # throws away exactly the false candidates - which is why a wider
        # radius only ever buys recall here.
        for d in [16, 20, 24, 28, 31, 64]:
            _, s = verified(measured, d)
            assert s.precision == 1.0

    def test_the_widest_duplicate_radius_matches_brute_force(self, measured):
        dists, truth = measured["dists"], measured["truth"]
        full_d = max(dists[p] for p in truth)
        assert full_d == 31
        count, s = verified(measured, full_d)
        assert (s.precision, s.recall, s.f1) == (1.0, 1.0, 1.0)
        assert count == 5041

    def test_at_the_bandings_budget_it_verifies_to_0_966_not_0_942(self, measured):
        count, s = verified(measured, 20)
        assert count == 353
        assert len(measured["banding"]) == 360
        assert count < len(measured["banding"])
        assert s.f1 == pytest.approx(0.966, abs=5e-4)
        assert s.f1 > 0.942

    def test_the_gap_is_the_candidate_bill_not_the_f1(self, measured):
        dists, truth = measured["dists"], measured["truth"]
        full_d = max(dists[p] for p in truth)
        count, s = verified(measured, full_d)
        banding = len(measured["banding"])
        assert s.f1 == 1.0
        assert count / banding == pytest.approx(14.0, abs=0.05)
        assert count / len(measured["pairs"]) == pytest.approx(0.490, abs=5e-4)


class TestEntryPointScoresBothSketchesTheSameWay:
    def test_the_verified_sweep_is_printed(self, capsys):
        entry.main()
        out = normalized(capsys.readouterr().out)
        assert "simhash as a candidate generator, verified with exact jaccard >= 0.2" in out
        assert (
            "d<=20: precision 1.000 recall 0.933 f1 0.966 with 353 verifications" in out
        )
        assert (
            "d<=31: precision 1.000 recall 1.000 f1 1.000 with 5041 verifications" in out
        )

    def test_the_cost_of_full_recall_is_printed_against_the_banding(self, capsys):
        entry.main()
        out = normalized(capsys.readouterr().out)
        assert "5041 verifications, 14.0x the tuned banding's 360" in out

    def test_the_head_to_head_names_verifications_on_both_sides(self, capsys):
        entry.main()
        out = normalized(capsys.readouterr().out)
        assert "minhash lsh + verify (b=64 r=2, t=0.2): f1 1.000 with 360 verifications" in out
        assert "simhash + verify (d<=31, t=0.2): f1 1.000 with 5041 verifications" in out
        assert "simhash alone, no verification (d<=20): f1 0.942" in out
        # the old line compared the unverified sketch to a verified pipeline
        # with nothing marking the difference.
        assert "simhash (d<=20): f1 0.942" not in out


class TestReadmeReadsTheGapAsCost:
    def test_readme_no_longer_publishes_0_942_as_simhashs_ceiling(self):
        text = normalized((ROOT / "README.md").read_text(encoding="utf-8"))
        assert "minhash lsh + verify 1.000, simhash 0.942" not in text
        assert "it has no verification story of its own" not in text

    def test_readme_carries_the_verified_numbers(self):
        text = normalized((ROOT / "README.md").read_text(encoding="utf-8"))
        assert "5041 verifications" in text
        assert "0.966" in text
        assert "14x" in text

    def test_root_index_row_does_not_cap_simhash_at_0_942(self):
        row = row_for("07", ROOT.parent / "README.md")
        assert "tops out at F1 0.942" not in row
        assert "5041" in row

    def test_ledger_row_carries_the_verified_reading(self):
        row = row_for(
            "07-near-duplicates", ROOT.parent / "progress.md", section="## COMPLETED"
        )
        assert "5041" in row
        assert "simhash best f1 0.942 vs pipeline 1.000" not in row
