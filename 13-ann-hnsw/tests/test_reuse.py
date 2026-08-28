import pytest

from ann.reuse import ann_recall, recall_at_k


def test_full_overlap_is_one() -> None:
    approx = [(3, 0.1), (1, 0.2), (2, 0.3)]
    exact = [(1, 0.1), (2, 0.2), (3, 0.3)]
    assert ann_recall(approx, exact, 3) == 1.0


def test_partial_overlap() -> None:
    approx = [(1, 0.1), (9, 0.2), (8, 0.3), (7, 0.4)]
    exact = [(1, 0.1), (2, 0.2), (3, 0.3), (4, 0.4)]
    assert ann_recall(approx, exact, 4) == 0.25


def test_shorter_lists_than_k_still_score() -> None:
    # an index holding fewer than k vectors returns short lists from both
    # sides; full agreement still reads 1.0
    approx = [(0, 0.0), (1, 0.5)]
    exact = [(0, 0.0), (1, 0.5)]
    assert ann_recall(approx, exact, 10) == 1.0


def test_imported_metric_contract_holds() -> None:
    # the underlying 02 metric divides by the relevant-set size
    assert recall_at_k(["a", "b"], ["a", "c"], 2) == 0.5
    with pytest.raises(ValueError):
        recall_at_k(["a"], [], 1)
