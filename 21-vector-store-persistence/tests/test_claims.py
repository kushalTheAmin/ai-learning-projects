"""Section 5's hub attack, held to what it actually removes.

The attack ranks live nodes by layer-0 degree, but layer-0 degree is capped
at m0 and a third of a built graph sits exactly at the cap, so the ranking
leaves hundreds of nodes tied. Resolving that tie by node id turns the whole
first batch into "the earliest-inserted nodes", and the reachability the
readme reported after 100 removals was that, not a hub effect. These tests
hold the entry point's selection and the readme's wording to the difference.
"""

import importlib.util
import re
from pathlib import Path

import numpy as np
import pytest

from vecstore import MutableHnswIndex, clustered_dataset

_ROOT = Path(__file__).resolve().parents[1]


def _load_entry_point():
    # load by path: sibling projects on sys.path also have a main.py
    path = _ROOT / "main.py"
    spec = importlib.util.spec_from_file_location("vecstore_main", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def entry_point():
    return _load_entry_point()


@pytest.fixture(scope="module")
def numbers() -> str:
    """Just the '## the numbers' section. The '## fixes' log quotes the
    retired wording on purpose — it is the record of the claim coming out,
    not the claim."""
    readme = (_ROOT / "README.md").read_text(encoding="utf-8")
    body = readme.split("## the numbers", 1)[1]
    return body.split("\n## ", 1)[0]


@pytest.fixture(scope="module")
def naive_index() -> MutableHnswIndex:
    data = clustered_dataset(n_vectors=300, n_queries=1, dim=8, n_clusters=4, seed=3)
    index = MutableHnswIndex(dim=8, m=8, ef_construction=40, seed=3, heuristic=False)
    for row in data.vectors:
        index.add(row)
    return index


class TestSelection:
    def test_degree_ties_are_most_of_the_first_batch(self, naive_index):
        """The premise: ranking by layer-0 degree cannot separate the cap group."""
        cap = naive_index.m0
        tied = [n for n in naive_index.live_ids() if naive_index.layer0_degree(n) == cap]
        assert len(tied) > 60, f"only {len(tied)} nodes at the cap, fixture is wrong"

    def test_the_attack_is_not_the_earliest_inserts(self, entry_point, naive_index):
        rng = np.random.default_rng(entry_point.HUB_TIE_SEEDS[0])
        picked = naive_index.highest_degree_live(60, rng)
        assert set(picked) != set(naive_index.live_ids()[:60])

    def test_attack_rows_are_deterministic_per_tie_seed(self, entry_point, naive_index):
        queries = np.random.default_rng(5).uniform(0.0, 1.0, size=(6, 8))
        steps = (30, 60)
        first = entry_point.hub_attack_rows(naive_index, queries, 0, steps=steps)
        assert first == entry_point.hub_attack_rows(naive_index, queries, 0, steps=steps)
        assert len(first) == len(steps)
        assert naive_index.deleted_count == 0, "the attack must not touch its source"

    def test_the_tie_draw_moves_the_answer(self, entry_point, naive_index):
        """The spread the readme publishes has to be a real spread."""
        queries = np.random.default_rng(5).uniform(0.0, 1.0, size=(20, 8))
        steps = (30, 60)
        runs = [
            entry_point.hub_attack_rows(naive_index, queries, seed, steps=steps)
            for seed in entry_point.HUB_TIE_SEEDS
        ]
        assert len({tuple(run) for run in runs}) > 1

    def test_more_than_one_tie_seed_is_reported(self, entry_point):
        assert len(entry_point.HUB_TIE_SEEDS) >= 3


class TestReadme:
    def test_section_five_names_the_tie_break(self, numbers):
        section = numbers.split("**5.", 1)[1]
        assert "tie" in section, "section 5 must say how degree ties are broken"
        assert re.search(r"\bseed", section), "section 5 must say the tie-break is seeded"

    def test_the_retired_collapse_claim_is_gone(self, numbers):
        assert "0.638" not in numbers
        assert not re.search(r"after just 100 removals", numbers)

    def test_the_cap_is_named_where_the_attack_is_described(self, numbers):
        section = numbers.split("**5.", 1)[1]
        assert "32" in section, "section 5 must name the layer-0 degree cap"

    def test_the_retired_cliff_claim_is_gone(self, numbers):
        section = numbers.split("**5.", 1)[1]
        assert "shrugs off 10%" not in section

    def test_section_five_publishes_the_first_batch_spread(self, numbers):
        section = numbers.split("**5.", 1)[1]
        assert "0.751" in section, "section 5 must publish the 100-removal reach min"
        assert "first batch" in section

    def test_section_five_labels_the_narrative_column_as_one_draw(self, numbers):
        section = numbers.split("**5.", 1)[1]
        assert "tie seed 0" in section


class TestCollapseShape:
    """The naive column's shape belongs to the tie draw, not to the graph.

    hub_attack_rows reports one draw. main.py runs five, and the min-max
    band it prints cannot tell a draw that falls at the first batch and
    then stays flat from a draw that holds and then cliffs — which is how
    section 5 came to describe the naive build as shrugging off 10%.
    """

    def test_one_draw_cannot_establish_the_shape(self, entry_point, naive_index):
        queries = np.random.default_rng(5).uniform(0.0, 1.0, size=(20, 8))
        steps = (30, 60)
        first = [
            entry_point.hub_attack_rows(naive_index, queries, seed, steps=steps)[0][1]
            for seed in entry_point.HUB_TIE_SEEDS
        ]
        assert min(first) < 0.5 < max(first), f"first-batch spread collapsed: {first}"
        assert max(first) - min(first) > 0.5

    def test_seed_shape_rows_reports_every_draw_and_every_step(self, entry_point):
        runs = [[(0.9, 1.0), (0.8, 0.9)] for _ in entry_point.HUB_TIE_SEEDS]
        rows = entry_point.seed_shape_rows(runs)
        assert [seed for seed, _ in rows] == list(entry_point.HUB_TIE_SEEDS)
        assert all(values == [(0.9, 1.0), (0.8, 0.9)] for _, values in rows)

    def test_seed_shape_rows_refuses_a_run_per_seed_mismatch(self, entry_point):
        with pytest.raises(ValueError, match="runs"):
            entry_point.seed_shape_rows([[(0.9, 1.0)]])


@pytest.fixture(scope="module")
def repair_section() -> str:
    """Just '## the repair extension'. The '## fixes' log quotes retired
    wording on purpose, so it stays out of the fixture."""
    readme = (_ROOT / "README.md").read_text(encoding="utf-8")
    body = readme.split("## the repair extension", 1)[1]
    return body.split("\n## ", 1)[0]


def _paragraph_with(section: str, needle: str) -> str:
    matches = [p for p in section.split("\n\n") if needle in p]
    assert matches, f"{needle!r} is not in the section at all"
    return " ".join(" ".join(matches).split())


class TestReselectVerdict:
    """The reselect verdict belongs to one of the two selection rules.

    At 600 removed the run prints no repair 0.597 / 0.633, reselect under
    nearest-only 0.549 / 0.135 and reselect under the diversity heuristic
    0.680 / 0.769 — the two rules land on opposite sides of never repairing
    at all, so the 0.135 headline cannot be published for both.
    """

    def test_the_unqualified_verdict_is_gone(self, repair_section):
        assert "**reselect is worse than doing nothing.**" not in repair_section

    def test_the_verdict_names_the_selection_rule(self, repair_section):
        paragraph = _paragraph_with(repair_section, "0.135")
        assert "naive selection" in paragraph or "nearest-only" in paragraph, (
            "the paragraph quoting 0.135 must say which selection rule it measured"
        )

    def test_the_heuristic_reselect_end_state_is_published(self, repair_section):
        assert "0.769" in repair_section, "heuristic reselect's end reachability"
        assert "0.680" in repair_section, "heuristic reselect's end recall"

    def test_the_cost_line_stops_calling_heuristic_reselect_worse_than_bare(
        self, repair_section
    ):
        paragraph = _paragraph_with(repair_section, "572.4%")
        assert "worse than bare unlinking" not in paragraph, (
            "heuristic reselect ends above bare on both axes at 600 removed"
        )

    def test_the_index_row_names_the_rule_behind_the_number(self):
        row = (_ROOT.parent / "README.md").read_text(encoding="utf-8")
        row = next(line for line in row.splitlines() if "0.135 reachability" in line)
        assert "nearest-only" in row or "naive selection" in row

    def test_the_two_reselect_rules_land_on_opposite_sides_of_bare(self, naive_index):
        """The mechanism behind the prose, on the small fixture: same policy,
        same batches, opposite verdicts against never repairing at all."""

        def reach(repair: bool, selection: bool | None = None) -> float:
            index = naive_index.clone()
            rng = np.random.default_rng(0)
            done = 0
            for count in (30, 60):
                batch = index.highest_degree_live(count - done, rng)
                done = count
                if repair:
                    index.unlink_with_repair(batch, heuristic=selection, reselect=True)
                else:
                    index.unlink_many(batch)
            return index.reachable_live_from_entry() / index.live_count

        bare = reach(False)
        assert reach(True, False) <= bare < reach(True, True)
