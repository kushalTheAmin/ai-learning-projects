import pytest

from neardup.evaluate import max_absolute_error, mean_absolute_error, score_pairs


class TestScorePairs:
    def test_perfect(self):
        truth = {("a", "b"), ("c", "d")}
        s = score_pairs(set(truth), truth)
        assert (s.precision, s.recall, s.f1) == (1.0, 1.0, 1.0)

    def test_no_predictions(self):
        s = score_pairs(set(), {("a", "b")})
        assert (s.precision, s.recall, s.f1) == (0.0, 0.0, 0.0)

    def test_partial(self):
        truth = {("a", "b"), ("c", "d"), ("e", "f"), ("g", "h")}
        predicted = {("a", "b"), ("c", "d"), ("x", "y")}
        s = score_pairs(predicted, truth)
        assert s.precision == pytest.approx(2 / 3)
        assert s.recall == pytest.approx(2 / 4)
        assert s.true_positives == 2

    def test_empty_truth_raises(self):
        with pytest.raises(ValueError):
            score_pairs({("a", "b")}, set())


class TestErrors:
    def test_mean(self):
        assert mean_absolute_error([(0.5, 0.4), (0.2, 0.4)]) == pytest.approx(0.15)

    def test_max(self):
        assert max_absolute_error([(0.5, 0.4), (0.2, 0.4)]) == pytest.approx(0.2)

    def test_empty_raises(self):
        with pytest.raises(ValueError):
            mean_absolute_error([])
        with pytest.raises(ValueError):
            max_absolute_error([])
