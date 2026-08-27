from neardup.shingles import word_shingles
from neardup.simhash import BITS, hamming_distance, simhash


class TestSimhash:
    def test_empty_set_is_zero(self):
        assert simhash(set()) == 0

    def test_fits_in_64_bits(self):
        fp = simhash(word_shingles("the quick brown fox jumps over the lazy dog"))
        assert 0 <= fp < 1 << BITS

    def test_identical_sets_identical_fingerprints(self):
        a = word_shingles("one two three four five")
        assert simhash(a) == simhash(set(a))

    def test_single_shingle_equals_its_hash(self):
        # With one voter, every bit follows that voter's hash exactly.
        assert simhash({"hello world"}) == 9765549648086544720

    def test_small_change_closer_than_disjoint(self):
        base = "a token bucket limiter refills at a fixed rate up to a burst capacity"
        near = base.replace("burst", "spike")
        far = "generational collectors bet that most objects die young in the nursery"
        fp_base = simhash(word_shingles(base))
        d_near = hamming_distance(fp_base, simhash(word_shingles(near)))
        d_far = hamming_distance(fp_base, simhash(word_shingles(far)))
        assert d_near < d_far


class TestHamming:
    def test_zero_for_equal(self):
        assert hamming_distance(12345, 12345) == 0

    def test_known_value(self):
        assert hamming_distance(0b1011, 0b0010) == 2

    def test_symmetric(self):
        assert hamming_distance(7, 999) == hamming_distance(999, 7)

    def test_max_distance(self):
        assert hamming_distance(0, (1 << 64) - 1) == 64
