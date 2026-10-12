"""The alpha sweep's maximum is a tie, and the report has to say so.

A best hyperparameter read off the same 40 queries it was tuned on is weak
evidence already; printing one member of a tied set as "the" best alpha
makes it look like the sweep resolved something it did not.
"""

import re
import subprocess
import sys
from pathlib import Path

import pytest

from hybrid_search.evaluate import best_alphas, load_json, sweep_alpha

PROJECT_DIR = Path(__file__).parent.parent
DATA_DIR = PROJECT_DIR / "data"
README = PROJECT_DIR / "README.md"

PRINTED_ALPHAS = [round(0.1 * i, 1) for i in range(11)]


@pytest.fixture(scope="module")
def sweep():
    corpus = load_json(DATA_DIR / "corpus.json")
    queries = load_json(DATA_DIR / "queries.json")
    return sweep_alpha(corpus, queries, PRINTED_ALPHAS)


@pytest.fixture(scope="module")
def printed():
    proc = subprocess.run(
        [sys.executable, str(PROJECT_DIR / "main.py")],
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert proc.returncode == 0, proc.stderr
    return proc.stdout


def _readme_prose() -> str:
    """The numbers section's bullets, whitespace normalized so a line wrap
    cannot decide whether a test passes."""
    text = README.read_text(encoding="utf-8")
    after_fence = text.split("## the numbers", 1)[1].split("```")[2]
    return " ".join(after_fence.split("\n## ", 1)[0].split())


def test_best_alphas_returns_every_tied_maximum():
    assert best_alphas({0.0: 0.5, 0.1: 0.9, 0.2: 0.9, 0.3: 0.4}) == [0.1, 0.2]


def test_best_alphas_returns_one_when_the_maximum_is_unique():
    assert best_alphas({0.0: 0.5, 0.1: 0.9, 0.2: 0.8}) == [0.1]


def test_best_alphas_ties_within_float_noise():
    # two rankings that put the first relevant doc at the same position in
    # every query agree to the last bit here, but a tie this metric means
    # mathematically must not come apart on an accumulation-order artifact
    assert best_alphas({0.1: 0.9, 0.2: 0.9 + 1e-15}) == [0.1, 0.2]


def test_best_alphas_rejects_an_empty_sweep():
    with pytest.raises(ValueError):
        best_alphas({})


def test_the_printed_grid_maximum_is_a_tie(sweep):
    assert best_alphas(sweep) == [0.2, 0.3]


def test_the_tied_alphas_agree_to_the_last_bit(sweep):
    assert sweep[0.2] == sweep[0.3]


def test_the_tied_maximum_is_rrfs_mrr_exactly(sweep):
    from hybrid_search.evaluate import aggregate, evaluate

    corpus = load_json(DATA_DIR / "corpus.json")
    queries = load_json(DATA_DIR / "queries.json")
    rrf = aggregate(evaluate(corpus, queries))["hybrid_rrf"]["mrr"]
    assert sweep[0.2] == rrf
    assert sweep[0.3] == rrf


def test_the_tied_alphas_are_not_the_same_ranking(sweep):
    # the tie is in the metric, not in the output — so it cannot be waved
    # away as "0.2 and 0.3 fuse to the same thing"
    import numpy as np

    from hybrid_search.evaluate import index_corpus
    from hybrid_search.fusion import weighted_score_fusion

    corpus = load_json(DATA_DIR / "corpus.json")
    queries = load_json(DATA_DIR / "queries.json")
    bm25, dense, _ = index_corpus(corpus)
    differs = any(
        not np.array_equal(
            weighted_score_fusion(bm25.scores(q["query"]), dense.scores(q["query"]), 0.2),
            weighted_score_fusion(bm25.scores(q["query"]), dense.scores(q["query"]), 0.3),
        )
        for q in queries
    )
    assert differs


def test_entry_point_names_both_tied_alphas(printed):
    line = [ln for ln in printed.splitlines() if "best alpha" in ln]
    assert len(line) == 1, printed
    assert "0.2" in line[0] and "0.3" in line[0], line[0]
    assert "tie" in line[0], line[0]


def test_entry_point_does_not_publish_a_single_best_alpha(printed):
    # the retired phrasing: one alpha, parenthesized score, no mention of the
    # other alpha that scores the same
    assert not re.search(r"best alpha on this query set: 0\.2 \(", printed)


def test_readme_does_not_claim_the_blend_reaches_rrf_at_one_alpha():
    prose = _readme_prose()
    assert "only at a=0.2" not in prose
    assert "best value on this set is 0.2" not in prose


def test_readme_names_the_tie():
    prose = _readme_prose()
    assert "a=0.2 and a=0.3" in prose
    assert "tie" in prose
