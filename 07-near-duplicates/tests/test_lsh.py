import pytest

from neardup.lsh import candidate_pairs, collision_probability, halfway_threshold
from neardup.minhash import MinHasher


class TestCandidatePairs:
    def test_hand_built_buckets(self):
        sigs = {
            "a": (1, 2, 3, 4),
            "b": (1, 2, 9, 9),
            "c": (8, 8, 9, 9),
        }
        # bands of 2 rows: a and b share band 0, b and c share band 1.
        assert candidate_pairs(sigs, bands=2, rows=2) == {("a", "b"), ("b", "c")}

    def test_identical_docs_always_candidates(self):
        hasher = MinHasher(16, seed=1)
        shingles = {i * 7 + 3 for i in range(40)}
        sigs = {"x": hasher.signature(shingles), "y": hasher.signature(set(shingles))}
        for bands, rows in [(16, 1), (8, 2), (4, 4), (1, 16)]:
            assert ("x", "y") in candidate_pairs(sigs, bands, rows)

    def test_disjoint_docs_not_candidates(self):
        hasher = MinHasher(16, seed=1)
        sigs = {
            "x": hasher.signature({i for i in range(100)}),
            "y": hasher.signature({i + 10_000 for i in range(100)}),
        }
        assert candidate_pairs(sigs, bands=4, rows=4) == set()

    def test_no_self_pairs_and_sorted_keys(self):
        sigs = {"b": (1, 1), "a": (1, 1)}
        pairs = candidate_pairs(sigs, bands=1, rows=2)
        assert pairs == {("a", "b")}

    def test_single_doc_no_pairs(self):
        assert candidate_pairs({"only": (1, 2)}, bands=1, rows=2) == set()

    def test_length_mismatch_raises(self):
        with pytest.raises(ValueError):
            candidate_pairs({"a": (1, 2, 3)}, bands=2, rows=2)


class TestSCurve:
    def test_endpoints(self):
        assert collision_probability(0.0, 32, 4) == 0.0
        assert collision_probability(1.0, 32, 4) == 1.0

    def test_hand_computed(self):
        # b=2, r=2 at s=0.5: 1 - (1 - 0.25)^2
        assert collision_probability(0.5, 2, 2) == pytest.approx(0.4375)

    def test_monotone_in_similarity(self):
        probs = [collision_probability(s / 10, 16, 8) for s in range(11)]
        assert probs == sorted(probs)

    def test_out_of_range(self):
        with pytest.raises(ValueError):
            collision_probability(1.5, 16, 8)

    def test_halfway_threshold_is_halfway(self):
        for bands, rows in [(64, 2), (32, 4), (16, 8), (8, 16)]:
            s = halfway_threshold(bands, rows)
            assert collision_probability(s, bands, rows) == pytest.approx(0.5)

    def test_more_rows_raises_threshold(self):
        assert halfway_threshold(16, 8) > halfway_threshold(64, 2)
