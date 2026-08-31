import pytest

from retrieval_eval.bootstrap import bootstrap_ci, paired_bootstrap, percentile

# reciprocal-rank-shaped data: mostly 1.0, a few lower ranks, a couple of misses
RR_LIKE = [1.0, 1.0, 1.0, 1.0, 1.0, 0.5, 1.0, 1.0, 0.333, 1.0,
           1.0, 0.25, 1.0, 1.0, 0.0, 1.0, 0.5, 1.0, 1.0, 0.0]


def test_percentile_endpoints_are_min_and_max():
    values = [1.0, 2.0, 5.0, 9.0]
    assert percentile(values, 0.0) == 1.0
    assert percentile(values, 1.0) == 9.0


def test_percentile_median_interpolates():
    assert percentile([1.0, 2.0, 3.0, 4.0], 0.5) == 2.5


def test_percentile_interpolates_between_positions():
    # position = 0.25 * 3 = 0.75 -> between 1.0 and 2.0, 75% of the way
    assert percentile([1.0, 2.0, 3.0, 4.0], 0.25) == pytest.approx(1.75)


def test_percentile_rejects_bad_inputs():
    with pytest.raises(ValueError):
        percentile([], 0.5)
    with pytest.raises(ValueError):
        percentile([1.0], -0.1)
    with pytest.raises(ValueError):
        percentile([1.0], 1.1)


def test_constant_values_give_zero_width_interval():
    ci = bootstrap_ci([0.5] * 20, n_resamples=200)
    assert ci.point == ci.lo == ci.hi == 0.5


def test_single_value_sample():
    ci = bootstrap_ci([0.7], n_resamples=100)
    assert ci.point == ci.lo == ci.hi == 0.7


def test_invalid_inputs_raise():
    with pytest.raises(ValueError):
        bootstrap_ci([])
    with pytest.raises(ValueError):
        bootstrap_ci([1.0], n_resamples=0)
    with pytest.raises(ValueError):
        bootstrap_ci([1.0], confidence=0.0)
    with pytest.raises(ValueError):
        bootstrap_ci([1.0], confidence=1.0)


def test_point_is_the_sample_mean():
    ci = bootstrap_ci(RR_LIKE, n_resamples=100)
    assert ci.point == pytest.approx(sum(RR_LIKE) / len(RR_LIKE))


def test_interval_brackets_the_point():
    ci = bootstrap_ci(RR_LIKE, n_resamples=2000)
    assert ci.lo <= ci.point <= ci.hi
    assert ci.lo < ci.hi  # non-degenerate data must give a real interval


def test_interval_stays_within_value_range():
    # a resampled mean can never leave [min, max] of the values
    ci = bootstrap_ci(RR_LIKE, n_resamples=2000)
    assert ci.lo >= min(RR_LIKE)
    assert ci.hi <= max(RR_LIKE)


def test_same_seed_reproduces_exactly():
    assert bootstrap_ci(RR_LIKE, seed=7) == bootstrap_ci(RR_LIKE, seed=7)


def test_different_seeds_differ():
    assert bootstrap_ci(RR_LIKE, n_resamples=500, seed=1) != bootstrap_ci(
        RR_LIKE, n_resamples=500, seed=2
    )


def test_wider_confidence_gives_wider_interval():
    narrow = bootstrap_ci(RR_LIKE, n_resamples=2000, confidence=0.80)
    wide = bootstrap_ci(RR_LIKE, n_resamples=2000, confidence=0.99)
    assert wide.hi - wide.lo > narrow.hi - narrow.lo


def test_more_data_narrows_the_interval():
    small = bootstrap_ci(RR_LIKE, n_resamples=2000)
    large = bootstrap_ci(RR_LIKE * 10, n_resamples=2000)
    assert (large.hi - large.lo) < (small.hi - small.lo)


def test_oversized_input_is_handled():
    ci = bootstrap_ci(RR_LIKE * 500, n_resamples=20)
    assert 0.0 <= ci.lo <= ci.hi <= 1.0


def test_identical_systems_compare_as_exactly_equal():
    result = paired_bootstrap(RR_LIKE, list(RR_LIKE), n_resamples=500)
    assert result.diff == 0.0
    assert result.ci.lo == result.ci.hi == 0.0
    # every resample lands exactly on zero, which counts on both sides
    assert result.p_le_zero == 1.0
    assert result.p_ge_zero == 1.0


def test_constant_offset_yields_degenerate_interval():
    # every per-query difference is exactly 0.25, so every paired resample
    # must average to exactly 0.25 — this fails if resampling is unpaired
    a = [0.0, 0.25, 0.5, 0.75, 1.0, 0.5, 0.75, 0.25]
    b = [x - 0.25 for x in a]
    result = paired_bootstrap(a, b, n_resamples=500)
    assert result.diff == 0.25
    assert result.ci.lo == result.ci.hi == 0.25
    assert result.p_le_zero == 0.0
    assert result.p_ge_zero == 1.0


def test_clear_winner_never_flips():
    a = [1.0] * 12
    b = [0.1] * 12
    result = paired_bootstrap(a, b, n_resamples=500)
    assert result.p_le_zero == 0.0
    assert result.ci.lo > 0.0


def test_noisy_tie_flips_sometimes():
    # per-query diffs are +/-0.5 in equal numbers: resampled means land on
    # both sides of zero, so the direction must not be stable
    a = [1.0, 0.0] * 6
    b = [0.5] * 12
    result = paired_bootstrap(a, b, n_resamples=2000, seed=3)
    assert result.diff == 0.0
    assert 0.0 < result.p_le_zero < 1.0
    assert 0.0 < result.p_ge_zero < 1.0
    # ties at exactly zero count on both sides, never on neither
    assert result.p_le_zero + result.p_ge_zero >= 1.0
    assert result.ci.lo < 0.0 < result.ci.hi


def test_clear_loser_mirrors_clear_winner():
    a = [0.1] * 12
    b = [1.0] * 12
    result = paired_bootstrap(a, b, n_resamples=500)
    assert result.p_ge_zero == 0.0
    assert result.p_le_zero == 1.0
    assert result.ci.hi < 0.0


def test_mismatched_lengths_raise():
    with pytest.raises(ValueError, match="equal length"):
        paired_bootstrap([1.0, 0.5], [1.0])


def test_empty_paired_samples_raise():
    with pytest.raises(ValueError):
        paired_bootstrap([], [])


def test_paired_comparison_is_deterministic():
    a = paired_bootstrap(RR_LIKE, RR_LIKE[::-1], seed=11)
    b = paired_bootstrap(RR_LIKE, RR_LIKE[::-1], seed=11)
    assert a == b
