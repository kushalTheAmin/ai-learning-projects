"""MaxSim must be the canonical late-interaction score, not a weighted variant.

ColBERT defines late interaction as S(q,d) = sum over query terms of the max
cosine to any document term (Khattab & Zaharia 2020, eq. 1): every query term
contributes its own best match with weight 1. Any per-term weighting is a
different scorer, so a result published about "late interaction" has to come
out of the unweighted sum or it measures the weighting instead.

These pin the formula term by term against a reference computed straight from
the term vectors, and pin the direction of the published maxsim rows that the
weighting was inverting.
"""

import numpy as np
import pytest

from reranking.data import Query
from reranking.rerank import MaxSimScorer, rerank


@pytest.fixture(scope="module")
def maxsim(evaluator):
    return MaxSimScorer(evaluator.space)


def reference_maxsim(space, query_text: str, doc_id: str) -> float:
    """Canonical MaxSim, written out directly from the definition."""
    query_indices = space.term_indices(query_text)
    doc_indices = space.profiles[doc_id].term_indices
    if len(query_indices) == 0 or len(doc_indices) == 0:
        return 0.0
    total = 0.0
    for qi in query_indices:
        total += max(
            float(space.term_vectors[qi] @ space.term_vectors[di])
            for di in doc_indices
        )
    return total


def make_query(text, relevant=("git-01",)):
    return Query(query_id="test", text=text, relevant=tuple(relevant), category="keyword")


def test_maxsim_matches_the_canonical_sum_term_by_term(evaluator, maxsim, queries):
    """The whole formula, against a reference built from the definition."""
    space = evaluator.space
    for query in queries[:12]:
        candidates = evaluator._stage_rankings["bm25"][query.query_id][:20]
        scores, _ = maxsim.score(query, candidates)
        for doc_id in candidates:
            assert scores[doc_id] == pytest.approx(
                reference_maxsim(space, query.text, doc_id), abs=1e-9
            ), (query.query_id, doc_id)


def test_query_terms_are_weighted_equally(evaluator, maxsim):
    """No idf (or any other) per-term weight: dropping a query term must move
    the score by exactly that term's own max, never by a weighted share."""
    space = evaluator.space
    doc_id = evaluator.doc_ids[0]
    # two terms with clearly different idf, both in vocabulary
    common, rare = "delete", "gateway"
    assert space.idf[space.term_indices(common)[0]] < space.idf[
        space.term_indices(rare)[0]
    ]
    both, _ = maxsim.score(make_query(f"{common} {rare}"), [doc_id])
    only_common, _ = maxsim.score(make_query(common), [doc_id])
    only_rare, _ = maxsim.score(make_query(rare), [doc_id])
    assert both[doc_id] == pytest.approx(
        only_common[doc_id] + only_rare[doc_id], abs=1e-9
    )


def test_full_term_match_scores_the_query_term_count(evaluator, maxsim, docs):
    """A doc holding every query term hits cosine 1.0 on each, so it reaches
    len(query terms) — the largest score any doc can reach, which is what
    makes the tie argument for keyword queries work."""
    space = evaluator.space
    doc = docs[0]
    words = [w for w in doc.text.split() if w.isalpha()][:3]
    text = " ".join(words)
    n_terms = len(space.term_indices(text))
    assert n_terms > 1, "need a multi-term query for this to bite"
    scores, _ = maxsim.score(make_query(text), [doc.doc_id])
    assert scores[doc.doc_id] == pytest.approx(float(n_terms), abs=1e-9)


def test_no_doc_outscores_a_full_match(evaluator, maxsim, docs):
    """len(query terms) is the ceiling: every per-term max is a cosine <= 1."""
    space = evaluator.space
    text = "delete remote branch"
    n_terms = len(space.term_indices(text))
    scores, _ = maxsim.score(make_query(text), [d.doc_id for d in docs])
    assert max(scores.values()) <= n_terms + 1e-9


def test_maxsim_reranking_beats_its_first_stage(evaluator):
    """The direction the weighting was inverting: over these same untrained
    term vectors, canonical late interaction improves on the bm25 stage it
    reranks at every swept depth, rather than losing to it."""
    bm25 = evaluator.run_first_stage("bm25")
    for depth in (10, 20, 100):
        maxsim = evaluator.run_reranked("bm25", "maxsim", depth)
        assert maxsim.system.mrr > bm25.mrr, depth


def test_maxsim_keyword_column_is_still_untouched(evaluator):
    """The tie mechanism survives the formula change: a keyword query's gold
    sits at the ceiling, and the stable sort leaves ties in stage order."""
    bm25 = evaluator.run_first_stage("bm25")
    for depth in (10, 20, 100):
        maxsim = evaluator.run_reranked("bm25", "maxsim", depth)
        assert maxsim.system.mrr_by_category["keyword"] == pytest.approx(
            bm25.mrr_by_category["keyword"], abs=1e-12
        )


def test_scores_stay_finite_on_a_degenerate_query(maxsim, docs):
    candidates = [d.doc_id for d in docs[:5]]
    for text in ("", "   \n\t", "GIL", "café 削除 🚀"):
        scores, _ = maxsim.score(make_query(text), candidates)
        assert np.isfinite(list(scores.values())).all(), text
