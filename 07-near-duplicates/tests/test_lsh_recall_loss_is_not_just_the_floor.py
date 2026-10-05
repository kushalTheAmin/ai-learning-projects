"""The mistuned banding's 31 missed pairs do not all come from its 50%
collision point sitting above the duplicate floor.

The s-curve 1 - (1 - s^r)^b is a probability, not a cutoff. Putting the 50%
point above the lowest duplicate jaccard does lose pairs, but only the ones
that sit below that point, and at b=32 r=4 there are 20 of those out of 360.
The other 22 misses are pairs *above* the 50% point, lost because the curve
is shallow there rather than absent: the highest sits at jaccard 0.581, a
pair the curve gives a 0.979 chance of bucketing. So the threshold placement
caps recall at 0.975, and the published 0.914 is mostly the tail underneath
that cap.
"""

from pathlib import Path

import pytest

import main as entry
from neardup.corpus import all_pairs, build_corpus, load_base_docs, true_duplicate_pairs
from neardup.lsh import candidate_pairs, collision_probability, halfway_threshold
from neardup.minhash import MinHasher
from neardup.shingles import hashed_shingles, jaccard, word_shingles

ROOT = Path(__file__).parent.parent
DATA_PATH = ROOT / "data" / "docs.jsonl"

BANDS, ROWS = entry.MISTUNED_BANDS, entry.MISTUNED_ROWS


@pytest.fixture(scope="module")
def measured():
    docs = build_corpus(load_base_docs(DATA_PATH), seed=entry.CORPUS_SEED)
    by_id = {d.doc_id: d for d in docs}
    truth = true_duplicate_pairs(docs)
    pairs = all_pairs(docs)
    shingles = {d.doc_id: word_shingles(d.text) for d in docs}
    exact = {p: jaccard(shingles[p[0]], shingles[p[1]]) for p in pairs}
    hasher = MinHasher(entry.SIGNATURE_K, seed=entry.MINHASH_SEED)
    sigs = {
        d.doc_id: hasher.signature(hashed_shingles(d.text)) for d in docs
    }
    cands = candidate_pairs(sigs, BANDS, ROWS)
    half = halfway_threshold(BANDS, ROWS)
    return {
        "by_id": by_id,
        "truth": truth,
        "pairs": pairs,
        "exact": exact,
        "cands": cands,
        "half": half,
        "missed": truth - cands,
    }


def normalized(text: str) -> str:
    return " ".join(text.split())


class TestTheThresholdExplainsNineOfThirtyOne:
    def test_the_banding_misses_thirty_one_of_the_three_hundred_sixty(self, measured):
        assert len(measured["truth"]) == 360
        assert len(measured["missed"]) == 31

    def test_the_verification_threshold_keeps_every_true_pair(self, measured):
        # the printed sentence counts the misses against brute force's set,
        # so the split's arithmetic only holds while that set is the truth
        # set - at t=0.2 it is, exactly.
        brute = {p for p in measured["pairs"] if measured["exact"][p] >= 0.2}
        assert brute == measured["truth"]

    def test_only_twenty_true_pairs_sit_below_the_fifty_percent_point(self, measured):
        half, exact = measured["half"], measured["exact"]
        assert half == pytest.approx(0.3826, abs=5e-5)
        below = [p for p in measured["truth"] if exact[p] < half]
        assert len(below) == 20

    def test_nine_of_the_misses_are_below_it_and_twenty_two_are_above(self, measured):
        half, exact = measured["half"], measured["exact"]
        below = [p for p in measured["missed"] if exact[p] < half]
        above = [p for p in measured["missed"] if exact[p] >= half]
        assert (len(below), len(above)) == (9, 22)

    def test_threshold_placement_caps_recall_at_0_975_not_0_914(self, measured):
        half, exact, truth = measured["half"], measured["exact"], measured["truth"]
        below_misses = [p for p in measured["missed"] if exact[p] < half]
        ceiling = 1 - len(below_misses) / len(truth)
        assert ceiling == pytest.approx(0.975, abs=5e-4)
        observed = 1 - len(measured["missed"]) / len(truth)
        assert observed == pytest.approx(0.914, abs=5e-4)
        assert ceiling > observed


class TestTheMissesAboveTheCurveAreTheTail:
    def test_the_highest_miss_is_a_pair_the_curve_all_but_guarantees(self, measured):
        exact = measured["exact"]
        highest = max(measured["missed"], key=lambda p: exact[p])
        assert highest == ("ratelimit-02--drop", "ratelimit-02--shuffle")
        assert exact[highest] == pytest.approx(0.581, abs=5e-4)
        assert collision_probability(
            exact[highest], BANDS, ROWS
        ) == pytest.approx(0.979, abs=5e-4)

    def test_the_curve_predicts_the_loss_it_produces(self, measured):
        exact, truth = measured["exact"], measured["truth"]
        expected = sum(
            1 - collision_probability(exact[p], BANDS, ROWS) for p in truth
        )
        assert expected == pytest.approx(35.2, abs=0.05)
        # 31 observed against 35.2 predicted: the banding is doing what the
        # s-curve says, which is exactly why "above the floor" cannot be the
        # whole story.
        assert abs(expected - len(measured["missed"])) < 0.2 * len(measured["missed"])

    def test_the_two_curve_readings_the_readme_quotes_are_the_curves(self):
        # the readme spends these as prose rather than table cells, so they
        # are not in main.py's output and need pinning here.
        assert collision_probability(0.280, BANDS, ROWS) == pytest.approx(
            0.179, abs=5e-4
        )
        assert collision_probability(0.462, BANDS, ROWS) == pytest.approx(
            0.775, abs=5e-4
        )

    def test_every_typo_pair_is_above_the_fifty_percent_point_and_two_still_miss(
        self, measured
    ):
        exact, half, by_id = measured["exact"], measured["half"], measured["by_id"]
        typo = [
            p
            for p in measured["truth"]
            if entry.pair_kind(by_id, p) == "typo"
        ]
        assert len(typo) == 24
        assert min(exact[p] for p in typo) > half
        missed_typo = [p for p in typo if p in measured["missed"]]
        assert len(missed_typo) == 2

    def test_below_the_point_is_only_ever_a_compounded_pair(self, measured):
        exact, half, by_id = measured["exact"], measured["half"], measured["by_id"]
        below = [p for p in measured["truth"] if exact[p] < half]
        assert {entry.pair_kind(by_id, p) for p in below} == {"mutant-mutant"}


class TestEntryPointPrintsTheSplit:
    def test_the_explanation_names_what_the_threshold_accounts_for(self, capsys):
        entry.main()
        out = normalized(capsys.readouterr().out)
        assert "never sees 31 of brute force's 360 pairs" in out
        assert "lowest duplicate jaccard (0.280)" in out
        assert "accounts for 9 of them" in out

    def test_both_sides_of_the_split_are_printed_with_their_denominators(
        self, capsys
    ):
        entry.main()
        out = normalized(capsys.readouterr().out)
        assert "below the 50% point: 20 pairs, 9 missed (recall ceiling 0.975)" in out
        assert "at or above it: 340 pairs, 22 missed (highest 0.581, p=0.979)" in out

    def test_the_curve_prediction_is_the_control(self, capsys):
        entry.main()
        out = normalized(capsys.readouterr().out)
        assert "the curve predicts 35.2 misses over all 360 pairs; 31 observed" in out


class TestReadmeMatchesTheSplit:
    def test_readme_does_not_credit_all_31_to_the_threshold(self):
        text = normalized((ROOT / "README.md").read_text(encoding="utf-8"))
        assert "31 missed pairs at b=32 r=4 all came from the curve sitting above the floor" not in text
        assert "sits above the floor, so 31 true pairs are never generated as candidates" not in text

    def test_readme_no_longer_says_above_the_curve_means_caught(self):
        text = normalized((ROOT / "README.md").read_text(encoding="utf-8"))
        assert "every single-mutation kind above the curve stays at 1.000" not in text

    def test_readme_carries_the_split_and_the_ceiling(self):
        text = normalized((ROOT / "README.md").read_text(encoding="utf-8"))
        assert "0.975" in text
        assert "22 of the 31" in text
        assert "20 of the 360" in text


class TestTheRepoLevelRowsMatchToo:
    """The index row and the ledger row published the same attribution."""

    def test_root_index_row_does_not_credit_all_31_to_the_floor(self):
        row = row_for("07", ROOT.parent / "README.md")
        assert "silently drops 31 pairs" in row
        assert "only 9 come from" in row
        assert "s-curve at 0.383, above the 0.280 duplicate floor" not in row

    def test_ledger_row_carries_the_split_and_the_live_kind_recall(self):
        row = row_for(
            "07-near-duplicates", ROOT.parent / "progress.md", section="## COMPLETED"
        )
        assert "mutant-mutant (0.812)" in row
        # 0.879 is the mutant-mutant recall the 2026-09-03 noise split
        # retired; the row outlived it by publishing it anyway.
        assert "0.879" not in row
        assert "only 9 sit below its 0.383 50% collision point" in row


def row_for(key: str, path: Path, section: str | None = None) -> str:
    """The one table row for `key`, optionally scoped to a `## ` section.

    progress.md carries a COMPLETED row and a REVIEWED row under the same
    project name, so the ledger row has to be addressed by its section.
    """
    lines = path.read_text(encoding="utf-8").splitlines()
    if section is not None:
        start = lines.index(section)
        end = next(
            (
                i
                for i in range(start + 1, len(lines))
                if lines[i].startswith("## ")
            ),
            len(lines),
        )
        lines = lines[start:end]
    rows = [line for line in lines if line.startswith(f"| {key} ")]
    assert len(rows) == 1, f"expected one {key!r} row in {path.name}, got {len(rows)}"
    return rows[0]
