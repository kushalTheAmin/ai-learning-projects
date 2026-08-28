import pytest

from groundedness.data import Claim
from groundedness.evaluate import (
    ScoredClaim,
    auc,
    best_operating_point,
    flag_rates_by_category,
    mean_score_by_support,
    operating_point,
)


def scored(score: float, supported: bool, category: str = "x", cid: str = "c") -> ScoredClaim:
    claim = Claim(id=cid, text="t", supported=supported, category=category)
    return ScoredClaim(claim=claim, context_id="ctx", score=score)


# 2 supported high, 2 unsupported low, 1 unsupported high (a miss)
MIXED = [
    scored(0.9, True),
    scored(0.8, True),
    scored(0.1, False),
    scored(0.2, False),
    scored(0.85, False),
]


class TestOperatingPoint:
    def test_counts_at_a_mid_threshold(self):
        point = operating_point(MIXED, 0.5)
        assert point.flagged == 2
        assert point.precision == 1.0
        assert point.recall == pytest.approx(2 / 3)
        assert point.false_positive_rate == 0.0
        assert point.youden_j == pytest.approx(2 / 3)
        assert point.f1 == pytest.approx(0.8)

    def test_flag_nothing(self):
        point = operating_point(MIXED, 0.0)
        assert point.flagged == 0
        assert point.precision == 0.0
        assert point.recall == 0.0
        assert point.f1 == 0.0

    def test_flag_everything_has_zero_j(self):
        point = operating_point(MIXED, 2.0)
        assert point.flagged == 5
        assert point.recall == 1.0
        assert point.false_positive_rate == 1.0
        assert point.youden_j == pytest.approx(0.0)

    def test_threshold_is_strict(self):
        # a claim scoring exactly the threshold is not flagged
        point = operating_point([scored(0.5, False), scored(0.9, True)], 0.5)
        assert point.flagged == 0


class TestBestOperatingPoint:
    def test_picks_the_separating_threshold(self):
        best = best_operating_point(MIXED)
        # thresholds 0.8 and 0.85 both flag {0.1, 0.2} plus nothing else
        # until 0.8 flags nothing extra; J is maximized at 2/3 first
        # reached at threshold 0.8
        assert best.youden_j == pytest.approx(2 / 3)
        assert best.threshold == pytest.approx(0.8)

    def test_tie_goes_to_the_lowest_threshold(self):
        # t=0.2 flags {0.1} for J=0.5; t=0.9 flags three of four for the
        # same J=0.5; the sweep keeps the lower threshold
        tied = [
            scored(0.9, True),
            scored(0.2, True),
            scored(0.1, False),
            scored(0.8, False),
        ]
        best = best_operating_point(tied)
        assert best.youden_j == pytest.approx(0.5)
        assert best.threshold == pytest.approx(0.2)

    def test_empty_rejected(self):
        with pytest.raises(ValueError):
            best_operating_point([])

    def test_indistinguishable_scores_give_zero_j(self):
        flat = [scored(0.5, True), scored(0.5, False)]
        assert best_operating_point(flat).youden_j == pytest.approx(0.0)


class TestAuc:
    def test_perfect_separation(self):
        assert auc([scored(0.9, True), scored(0.1, False)]) == 1.0

    def test_inverted_separation(self):
        assert auc([scored(0.1, True), scored(0.9, False)]) == 0.0

    def test_all_ties_is_a_coin_flip(self):
        assert auc([scored(0.5, True), scored(0.5, False)]) == 0.5

    def test_hand_computed_mixed_case(self):
        # pairs: (0.85 vs 0.9) win, (0.85 vs 0.8) loss, (0.1, 0.2) beat both
        assert auc(MIXED) == pytest.approx(5 / 6)

    def test_single_class_rejected(self):
        with pytest.raises(ValueError):
            auc([scored(0.5, True)])


class TestFlagRates:
    def test_rates_by_category(self):
        claims = [
            scored(0.1, False, category="negation_flip"),
            scored(0.9, False, category="negation_flip"),
            scored(0.95, True, category="paraphrase"),
        ]
        rates = flag_rates_by_category(claims, 0.5)
        assert rates == {"negation_flip": (1, 2), "paraphrase": (0, 1)}


class TestMeanScoreBySupport:
    def test_means(self):
        sup, unsup = mean_score_by_support(MIXED)
        assert sup == pytest.approx(0.85)
        assert unsup == pytest.approx((0.1 + 0.2 + 0.85) / 3)

    def test_single_class_rejected(self):
        with pytest.raises(ValueError):
            mean_score_by_support([scored(0.5, True)])
