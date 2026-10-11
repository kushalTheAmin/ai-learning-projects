"""How exactly the pooled rerank reproduces the full dense scan — counted.

The README led with "reranking 20 candidates reproduced the full dense scan
exactly", on the strength of per-query rr@10 equality. rr@10 is blind past
rank 10: two rankings that both leave the gold outside the top 10 agree at
0.0 however far apart they put it. Counting the gold's actual rank instead
puts the identity at 39 of 40 queries at depth 20, with p09 the exception —
the dense scan finds unix-03 at rank 12, the two-stage pipeline leaves it at
bm25's rank 24 because the depth-20 shortlist stops short of it.

These pin the measurement (the per-depth identity counts, p09's two ranks,
the cutoff that hides them, the k where the two mrr values separate) and
hold both readmes to the counted reading.
"""

from pathlib import Path

import pytest

from reranking.evaluate import DEPTHS, HEADLINE_DEPTH, MRR_K, first_relevant_rank
from reranking.rerank import rerank
from reranking.reuse import mean, reciprocal_rank

PROJECT = Path(__file__).parent.parent
README = PROJECT / "README.md"
ROOT_README = PROJECT.parent / "README.md"


def normalized(path: Path) -> str:
    """Whitespace-normalized, so a line wrap cannot make a prose test pass."""
    return " ".join(path.read_text(encoding="utf-8").split())


def two_stage_ranking(evaluator, query, depth: int) -> list[str]:
    """The pooled rerank of bm25's shortlist, tail appended — as main.py runs it."""
    stage_ranking = evaluator._stage_rankings["bm25"][query.query_id]
    result = rerank(evaluator.scorers["pooled-lsa"], query, stage_ranking[:depth])
    return result.ranked_ids + stage_ranking[depth:]


class TestTheIdentityIsCounted:
    def test_the_audit_at_the_headline_depth(self, evaluator):
        audit = evaluator.dense_identity_audit(HEADLINE_DEPTH)
        assert audit.queries == 40
        # every query agrees on rr@10 — that is the claim the README made
        assert audit.rr_identical == 40
        # but one query does not agree on where the gold actually lands
        assert audit.gold_rank_identical == 39
        assert len(audit.gaps) == 1
        gap = audit.gaps[0]
        assert (gap.query_id, gap.dense_rank, gap.reranked_rank) == ("p09", 12, 24)

    def test_the_identity_count_by_depth(self, evaluator):
        """20 candidates is not where the rankings converge: 50 is."""
        counts = {
            depth: evaluator.dense_identity_audit(depth).gold_rank_identical
            for depth in DEPTHS
        }
        assert counts == {5: 38, 10: 38, 20: 39, 50: 40, 100: 40}
        # rr@10 reports a clean sweep from depth 20 on, including at 20 where
        # the rankings still disagree: p09's gold is past rank 10 under both,
        # so no shortlist depth makes that gap visible to the metric
        rr_counts = {
            depth: evaluator.dense_identity_audit(depth).rr_identical
            for depth in DEPTHS
        }
        assert rr_counts == {5: 39, 10: 39, 20: 40, 50: 40, 100: 40}

    def test_the_gap_is_the_shortlist_ceiling_not_the_scorer(self, evaluator, queries):
        """p09's gold sits at bm25 rank 24, so a depth-20 shortlist cannot
        reach it however good the scorer is — the gold-in-shortlist 0.950
        column is this same query showing up as a recall miss."""
        p09 = next(q for q in queries if q.query_id == "p09")
        gold = p09.relevant[0]
        assert gold == "unix-03"
        stage_ranking = evaluator._stage_rankings["bm25"]["p09"]
        assert stage_ranking.index(gold) + 1 == 24
        assert gold not in stage_ranking[:HEADLINE_DEPTH]
        # deepen the shortlist past it and the identity closes
        assert first_relevant_rank(
            two_stage_ranking(evaluator, p09, 50), set(p09.relevant)
        ) == first_relevant_rank(
            evaluator._stage_rankings["lsa"]["p09"], set(p09.relevant)
        )

    def test_rr_at_ten_cannot_see_the_gap(self, evaluator, queries):
        """Both rankings score 0.0 on p09 while putting the gold 12 ranks
        apart: the agreement there is the metric's cutoff, not the pipeline."""
        p09 = next(q for q in queries if q.query_id == "p09")
        relevant = list(p09.relevant)
        dense = evaluator._stage_rankings["lsa"]["p09"]
        reranked = two_stage_ranking(evaluator, p09, HEADLINE_DEPTH)
        assert reciprocal_rank(dense, relevant, MRR_K) == 0.0
        assert reciprocal_rank(reranked, relevant, MRR_K) == 0.0
        assert first_relevant_rank(dense, set(relevant)) == 12
        assert first_relevant_rank(reranked, set(relevant)) == 24

    def test_the_other_query_past_the_cutoff_really_does_agree(
        self, evaluator, queries
    ):
        """k14 is the second query whose gold misses the depth-20 shortlist,
        and it is not a hidden gap: both rankings put py-03 at rank 39, so
        the audit counts it with the 39 rather than against them."""
        k14 = next(q for q in queries if q.query_id == "k14")
        relevant = set(k14.relevant)
        dense = evaluator._stage_rankings["lsa"]["k14"]
        reranked = two_stage_ranking(evaluator, k14, HEADLINE_DEPTH)
        assert first_relevant_rank(dense, relevant) == 39
        assert first_relevant_rank(reranked, relevant) == 39
        assert k14.query_id not in [
            gap.query_id
            for gap in evaluator.dense_identity_audit(HEADLINE_DEPTH).gaps
        ]

    def test_the_two_mrr_values_separate_once_k_clears_the_gap(
        self, evaluator, queries
    ):
        """The identity is a property of rr@10, not of the two systems: move
        the cutoff to 12 and the dense scan is ahead by +0.002."""
        dense = evaluator._stage_rankings["lsa"]
        reranked = {
            q.query_id: two_stage_ranking(evaluator, q, HEADLINE_DEPTH)
            for q in queries
        }

        def mrr(rankings, k):
            return mean(
                [
                    reciprocal_rank(rankings[q.query_id], list(q.relevant), k)
                    for q in queries
                ]
            )

        assert mrr(dense, MRR_K) == pytest.approx(mrr(reranked, MRR_K), abs=1e-12)
        at_12 = mrr(dense, 12) - mrr(reranked, 12)
        assert at_12 == pytest.approx(0.002083, abs=5e-6)

    def test_the_rankings_themselves_are_not_reproduced(self, evaluator, queries):
        """What coincides is where the gold lands, not the ordering: the top
        10s differ on 22 of the 40 queries."""
        differing = sum(
            1
            for q in queries
            if two_stage_ranking(evaluator, q, HEADLINE_DEPTH)[:10]
            != evaluator._stage_rankings["lsa"][q.query_id][:10]
        )
        assert differing == 22

    def test_first_relevant_rank_is_one_indexed_and_strict(self):
        assert first_relevant_rank(["a", "b", "c"], {"a"}) == 1
        assert first_relevant_rank(["a", "b", "c"], {"c"}) == 3
        assert first_relevant_rank(["a", "b", "c"], {"c", "b"}) == 2
        with pytest.raises(ValueError, match="no relevant doc"):
            first_relevant_rank(["a", "b"], {"z"})

    def test_audit_rejects_a_nonpositive_depth(self, evaluator):
        with pytest.raises(ValueError, match="depth"):
            evaluator.dense_identity_audit(0)


class TestTheSurfacesCarryTheCountedReading:
    RETIRED = (
        "reranking 20 candidates reproduced the full dense scan exactly",
        "a test pins the per-query identity",
    )

    def test_project_readme_drops_the_exact_reproduction_claim(self):
        text = normalized(README)
        for phrase in self.RETIRED:
            assert phrase not in text, phrase

    def test_project_readme_states_the_counted_identity(self):
        text = normalized(README)
        assert "39 of 40" in text
        assert "p09" in text

    def test_project_readme_names_the_cutoff_and_the_depth_that_closes_it(self):
        text = normalized(README)
        assert "rank 12" in text
        assert "rank 24" in text
        assert "depth 50" in text

    def test_root_readme_index_row_names_the_hidden_query(self):
        text = normalized(ROOT_README)
        assert "39 of the 40" in text
        assert "p09" in text

    def test_the_fixes_section_records_this_change(self):
        text = normalized(README)
        assert "## fixes" in README.read_text(encoding="utf-8")
        assert "2026-10-11" in text
