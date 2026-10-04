"""Why the keyword column is untouched — counted, not asserted.

The README credited the flat 0.950 keyword column to docs reaching MaxSim's
|query terms| ceiling together and the stable sort resolving the tie by
first-stage order. The ceiling is real, the tie is not: the keyword gold is
the only doc on the ceiling on every keyword query that has an in-vocabulary
term, at every swept depth, so it wins outright and there is no tie to break.

These pin the measurement (the tie count, the unique-argmax count, and a
synthetic case proving the tie counter can fire at all so its 0 is not
vacuous) and hold the three surfaces that carried the retired mechanism to
the corrected reading.
"""

from pathlib import Path

import pytest

from reranking.evaluate import DEPTHS, HEADLINE_DEPTH, ceiling_hits
from reranking.rerank import rerank

PROJECT = Path(__file__).parent.parent
README = PROJECT / "README.md"
ROOT_README = PROJECT.parent / "README.md"


def normalized(path: Path) -> str:
    """Whitespace-normalized, so a line wrap cannot make a prose test pass."""
    return " ".join(path.read_text(encoding="utf-8").split())


class TestTheCeilingTieNeverFires:
    def test_the_audit_at_the_headline_depth(self, evaluator):
        audit = evaluator.keyword_ceiling_audit(HEADLINE_DEPTH)
        # 20 keyword queries, k14 ("GIL") has no in-vocabulary term
        assert audit.scored == 19
        assert audit.gold_at_ceiling == 19
        assert audit.gold_strict_top == 19
        assert audit.ceiling_ties == 0

    def test_no_ceiling_tie_at_any_swept_depth(self, evaluator):
        for depth in DEPTHS:
            audit = evaluator.keyword_ceiling_audit(depth)
            assert audit.ceiling_ties == 0, depth
            assert audit.gold_strict_top == audit.scored, depth

    def test_the_gold_is_the_only_doc_on_the_ceiling_by_hand(self, evaluator, queries):
        """The same count again, straight from the scorer, without the audit."""
        space = evaluator.space
        maxsim = evaluator.scorers["maxsim"]
        checked = 0
        for query in queries:
            if query.category != "keyword":
                continue
            ceiling = float(len(space.term_indices(query.text)))
            if ceiling == 0.0:
                continue
            shortlist = evaluator._stage_rankings["bm25"][query.query_id][:100]
            scores, _ = maxsim.score(query, shortlist)
            on_ceiling = ceiling_hits(scores, ceiling)
            assert on_ceiling == [query.relevant[0]], query.query_id
            checked += 1
        assert checked == 19

    def test_the_gold_wins_outright_so_stage_order_is_never_consulted(
        self, evaluator, queries
    ):
        """An outright win, not a tie-break: the gold stays rank 1 even when
        the shortlist is handed over in an order that would sink it if the
        sort were resolving a tie."""
        maxsim = evaluator.scorers["maxsim"]
        space = evaluator.space
        for query in queries:
            if query.category != "keyword":
                continue
            if len(space.term_indices(query.text)) == 0:
                continue
            shortlist = evaluator._stage_rankings["bm25"][query.query_id][:20]
            reversed_shortlist = list(reversed(shortlist))
            assert reversed_shortlist[-1] == query.relevant[0], query.query_id
            result = rerank(maxsim, query, reversed_shortlist)
            assert result.ranked_ids[0] == query.relevant[0], query.query_id

    def test_the_tie_counter_can_fire(self):
        """So the 0 above is a measurement and not a counter that never counts."""
        tied = ceiling_hits({"a": 3.0, "b": 3.0, "c": 1.5}, 3.0)
        assert sorted(tied) == ["a", "b"]
        alone = ceiling_hits({"a": 3.0, "b": 2.0}, 3.0)
        assert alone == ["a"]
        assert ceiling_hits({"a": 2.0}, 3.0) == []

    def test_the_tie_counter_tolerates_float_noise(self):
        assert ceiling_hits({"a": 3.0 - 1e-12}, 3.0) == ["a"]
        assert ceiling_hits({"a": 3.0 - 1e-3}, 3.0) == []

    def test_audit_rejects_a_nonpositive_depth(self, evaluator):
        with pytest.raises(ValueError, match="depth"):
            evaluator.keyword_ceiling_audit(0)


class TestTheKeywordColumnIsNotAScorerProperty:
    def test_pooled_lsa_reorders_keyword_shortlists_and_spares_the_gold_anyway(
        self, evaluator, queries
    ):
        """No ceiling argument covers the pooled scorer: it reshuffles almost
        every keyword shortlist and leaves the gold at rank 1 regardless, so
        that column is bm25 and lsa agreeing, not a structural guarantee."""
        pooled = evaluator.scorers["pooled-lsa"]
        reordered = 0
        gold_moved = 0
        keyword = [q for q in queries if q.category == "keyword"]
        for query in keyword:
            shortlist = evaluator._stage_rankings["bm25"][query.query_id][:20]
            result = rerank(pooled, query, shortlist)
            if result.ranked_ids != shortlist:
                reordered += 1
            gold = query.relevant[0]
            if gold in shortlist and result.ranked_ids.index(gold) != shortlist.index(
                gold
            ):
                gold_moved += 1
        assert len(keyword) == 20
        assert reordered == 19
        assert gold_moved == 0


class TestTheSurfacesCarryTheCorrectedMechanism:
    RETIRED = (
        "docs that reach that ceiling tie there while the stable sort "
        "resolves ties by first-stage order",
        "the reranker structurally cannot damage what the lexical stage "
        "already got right",
    )

    def test_project_readme_drops_the_retired_tie_mechanism(self):
        text = normalized(README)
        for phrase in self.RETIRED:
            assert phrase not in text, phrase

    def test_project_readme_states_the_unique_ceiling_reading(self):
        text = normalized(README)
        assert "only doc on the ceiling" in text
        assert "19 of the 19 keyword queries" in text
        assert "no tie to break" in text

    def test_project_readme_does_not_generalize_the_ceiling_to_every_scorer(self):
        text = normalized(README)
        assert "keyword queries are immune to every scorer, by mechanism" not in text

    def test_root_readme_index_row_drops_the_tie_mechanism(self):
        text = normalized(ROOT_README)
        assert "exact-match cosine ties plus a stable sort leave every keyword" not in text
        assert "only doc on MaxSim's exact-match ceiling" in text

    def test_the_fixes_section_records_this_change(self):
        text = normalized(README)
        assert "## fixes" in README.read_text(encoding="utf-8")
        assert "2026-10-04" in text
