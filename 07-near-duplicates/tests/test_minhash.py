import pytest

from neardup.minhash import EMPTY_SENTINEL, MinHasher, estimate_jaccard
from neardup.shingles import jaccard


def make_sets(overlap: int, only_a: int, only_b: int) -> tuple[set[int], set[int]]:
    shared = {i * 1_000_003 + 17 for i in range(overlap)}
    a = shared | {i * 999_983 + 500_000_001 for i in range(only_a)}
    b = shared | {i * 999_979 + 900_000_007 for i in range(only_b)}
    return a, b


class TestSignature:
    def test_identical_sets_identical_signatures(self):
        hasher = MinHasher(32, seed=1)
        a, _ = make_sets(50, 0, 0)
        assert hasher.signature(a) == hasher.signature(set(a))

    def test_deterministic_across_instances(self):
        a, _ = make_sets(30, 10, 0)
        assert MinHasher(32, seed=5).signature(a) == MinHasher(32, seed=5).signature(a)

    def test_seed_changes_signature(self):
        a, _ = make_sets(30, 10, 0)
        assert MinHasher(32, seed=5).signature(a) != MinHasher(32, seed=6).signature(a)

    def test_prefix_property(self):
        # The first k hash functions of a larger family are exactly the
        # smaller family, so sweeps can truncate one big signature.
        a, _ = make_sets(40, 20, 0)
        big = MinHasher(128, seed=7).signature(a)
        small = MinHasher(32, seed=7).signature(a)
        assert big[:32] == small

    def test_empty_set_is_sentinel(self):
        hasher = MinHasher(16, seed=1)
        assert hasher.signature(set()) == (EMPTY_SENTINEL,) * 16

    def test_two_empty_docs_estimate_one(self):
        hasher = MinHasher(16, seed=1)
        sig = hasher.signature(set())
        assert estimate_jaccard(sig, sig) == 1.0

    def test_empty_vs_nonempty_estimate_zero(self):
        hasher = MinHasher(16, seed=1)
        a, _ = make_sets(20, 0, 0)
        assert estimate_jaccard(hasher.signature(set()), hasher.signature(a)) == 0.0

    def test_invalid_num_hashes(self):
        with pytest.raises(ValueError):
            MinHasher(0, seed=1)


class TestEstimate:
    def test_identical(self):
        hasher = MinHasher(64, seed=2)
        a, _ = make_sets(80, 0, 0)
        sig = hasher.signature(a)
        assert estimate_jaccard(sig, sig) == 1.0

    def test_estimate_tracks_exact(self):
        hasher = MinHasher(128, seed=3)
        for overlap, only in [(100, 50), (60, 60), (20, 80)]:
            a, b = make_sets(overlap, only, only)
            exact = jaccard(a, b)
            est = estimate_jaccard(hasher.signature(a), hasher.signature(b))
            assert est == pytest.approx(exact, abs=0.13)

    def test_error_shrinks_with_k(self):
        hasher = MinHasher(128, seed=4)
        pairs = [make_sets(o, 40, 40) for o in (20, 40, 60, 80, 100)]
        sigs = [(hasher.signature(a), hasher.signature(b), jaccard(a, b)) for a, b in pairs]
        err_small = sum(abs(estimate_jaccard(sa, sb, 8) - j) for sa, sb, j in sigs)
        err_large = sum(abs(estimate_jaccard(sa, sb, 128) - j) for sa, sb, j in sigs)
        assert err_large < err_small

    def test_truncated_k(self):
        hasher = MinHasher(64, seed=5)
        a, b = make_sets(50, 25, 25)
        sa, sb = hasher.signature(a), hasher.signature(b)
        full = estimate_jaccard(sa, sb)
        half = estimate_jaccard(sa, sb, 32)
        assert 0.0 <= half <= 1.0
        assert full == estimate_jaccard(sa, sb, 64)

    def test_length_mismatch(self):
        with pytest.raises(ValueError):
            estimate_jaccard((1, 2), (1, 2, 3))

    def test_bad_k(self):
        with pytest.raises(ValueError):
            estimate_jaccard((1, 2), (1, 2), k=3)
        with pytest.raises(ValueError):
            estimate_jaccard((1, 2), (1, 2), k=0)
