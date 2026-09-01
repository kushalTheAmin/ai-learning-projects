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
