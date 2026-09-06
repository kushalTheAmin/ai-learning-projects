"""Where a layer-0 walk actually starts, and what the naive ablation's recall
drop is really made of.

The published `layer-0 reachable` column walks out from the top-layer entry
point. That is where the *descent* starts; the layer-0 beam starts wherever the
descent lands, which on the naive graph is a different node per query and can
sit in a different component entirely. These tests pin both halves: the start
node the search really uses, and the split of missed neighbors into the ones no
walk from that start could reach and the ones the beam simply settled short of.
"""

import importlib.util
import re
from pathlib import Path

import numpy as np
import pytest

from ann.dataset import clustered_dataset
from ann.exact import ExactIndex
from ann.hnsw import HnswIndex

_PROJECT = Path(__file__).resolve().parents[1]


def _load_main():
    """Load this project's main.py by path. A plain `import main` is not safe
    here: ann.reuse prepends 02-retrieval-eval to sys.path and that project
    has a main.py of its own, so which one wins depends on import order."""
    spec = importlib.util.spec_from_file_location("ann_hnsw_main", _PROJECT / "main.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


main = _load_main()

ABLATION_N = 2000
ABLATION_QUERIES = 150
DIM = 32
ABLATION_M = 8
EF = 32
K = 10

README = _PROJECT / "README.md"


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text)


def readme_without_fixes() -> str:
    """The readme with the `## fixes` section cut out: fix entries quote the
    sentences they retired, so a prose test has to read around them."""
    text = README.read_text()
    start = text.index("\n## fixes\n")
    end = text.index("\n## ", start + 1)
    return normalize(text[:start] + text[end:])


@pytest.fixture(scope="module")
def naive_tight():
    """The exact fixture main.py's ablation prints its naive tight-clusters
    row from: same n, dim, clusters, std, M, efConstruction and seed."""
    data = clustered_dataset(
        ABLATION_N, ABLATION_QUERIES, DIM, 32, seed=42, cluster_std=0.06
    )
    index = HnswIndex(dim=DIM, m=ABLATION_M, ef_construction=100, seed=42, heuristic=False)
    for row in data.vectors:
        index.add(row)
    exact = ExactIndex(dim=DIM)
    for row in data.vectors:
        exact.add(row)
    truth = [exact.search(q, K) for q in data.queries]
    return index, data, truth


# -- the start node a search really uses ---------------------------------


def test_layer0_entry_is_the_descent_endpoint_not_the_entry_point(naive_tight) -> None:
    index, data, _ = naive_tight
    starts = [index.layer0_entry(q) for q in data.queries]
    assert all(s is not None for s in starts)
    # the top-layer entry point is one of many starts, not the start
    assert any(s != index._entry for s in starts)
    assert len(set(starts)) == 74


def test_the_starts_sit_in_four_different_components(naive_tight) -> None:
    index, data, _ = naive_tight
    sizes = sorted(
        {len(index.reachable_from_on_layer0(index.layer0_entry(q))) for q in data.queries}
    )
    # the finding as an invariant: what a query can walk to on layer 0 is not
    # one number for the graph, it is four here
    assert sizes == [61, 88, 1855, 1926]


def test_the_entry_points_component_is_neither_the_only_nor_the_largest(
    naive_tight,
) -> None:
    index, data, _ = naive_tight
    published = index.reachable_on_layer0()
    assert published == 1855
    assert published == len(index.reachable_from_on_layer0(index._entry))
    # a query whose descent lands elsewhere reaches 1926, so the published
    # column is not a ceiling on what a search sees
    largest = max(
        len(index.reachable_from_on_layer0(index.layer0_entry(q))) for q in data.queries
    )
    assert largest == 1926
    assert largest > published


def test_reachable_on_layer0_still_defaults_to_the_entry_point(naive_tight) -> None:
    index, _, _ = naive_tight
    assert index.reachable_on_layer0() == index.reachable_on_layer0(index._entry)
    assert index.reachable_on_layer0(index._entry) == 1855


def test_search_runs_its_layer0_beam_from_layer0_entry(naive_tight) -> None:
    """Behaviour pin: extracting the descent must not move a single result."""
    index, data, _ = naive_tight
    for query in data.queries[:20]:
        checked = index._check(query)
        start = index.layer0_entry(query)
        found = index._search_layer(checked, [start], EF, 0)
        assert index.search(query, K, ef=EF) == [(n, d) for d, n in found[:K]]


def test_a_tiny_component_start_really_is_a_dead_end(naive_tight) -> None:
    index, data, _ = naive_tight
    pockets = [
        q
        for q in data.queries
        if len(index.reachable_from_on_layer0(index.layer0_entry(q))) < 100
    ]
    assert len(pockets) == 10
    for query in pockets:
        reach = index.reachable_from_on_layer0(index.layer0_entry(query))
        assert {node for node, _ in index.search(query, K, ef=EF)} <= reach


# -- what the recall drop is made of --------------------------------------


def test_unreachability_is_the_smaller_half_of_the_naive_miss(naive_tight) -> None:
    index, data, truth = naive_tight
    slots, unreachable, in_reach, starts, sizes = main.miss_attribution(
        index, data, truth, ef=EF
    )
    assert (slots, unreachable, in_reach) == (1500, 51, 236)
    assert (starts, sizes) == (74, [61, 88, 1855, 1926])
    # recall 0.809 is 287 missed gold neighbors out of 1500
    assert unreachable + in_reach == 287
    # the claim the readme used to make, refuted: stranding accounts for well
    # under a fifth of the drop, the rest is the beam settling short
    assert unreachable / (unreachable + in_reach) < 0.2


def test_the_heuristic_graph_has_one_component_and_one_start_class() -> None:
    data = clustered_dataset(600, 40, 16, 20, seed=7, cluster_std=0.05)
    index = HnswIndex(dim=16, m=6, ef_construction=60, seed=7, heuristic=True)
    for row in data.vectors:
        index.add(row)
    sizes = {
        len(index.reachable_from_on_layer0(index.layer0_entry(q))) for q in data.queries
    }
    assert sizes == {600}


def test_layer0_entry_on_an_empty_index() -> None:
    index = HnswIndex(dim=3, m=4, ef_construction=10, seed=0)
    assert index.layer0_entry(np.zeros(3)) is None
    assert index.reachable_on_layer0() == 0
    with pytest.raises(ValueError):
        index.layer0_entry(np.zeros(2))


def test_single_node_index_starts_at_itself() -> None:
    index = HnswIndex(dim=2, m=4, ef_construction=10, seed=0)
    index.add(np.array([1.0, 0.0]))
    assert index.layer0_entry(np.zeros(2)) == 0
    assert index.reachable_from_on_layer0(0) == {0}


# -- the readme says what the code measures -------------------------------


def test_readme_prints_the_attribution_block(naive_tight) -> None:
    index, data, truth = naive_tight
    block = "\n".join(main.miss_attribution_block(index, data, truth, ef=EF, n=ABLATION_N))
    assert normalize(block) in normalize(README.read_text())


def test_readme_no_longer_reads_stranding_as_the_cause() -> None:
    text = readme_without_fixes()
    assert "strands 145 of 2000 nodes unreachable from the entry point" not in text
    assert "every search begins" not in text


def test_readme_names_the_real_split() -> None:
    text = readme_without_fixes()
    assert "only 51 of the 287 gold neighbors it misses are unreachable" in text
    assert "the other 236 sit inside reach" in text


def test_readme_explains_what_the_reachable_column_is() -> None:
    text = readme_without_fixes()
    assert (
        "it is a structural stat about the graph, not a ceiling on what a query "
        "can see" in text
    )
    assert "74 different nodes over 150 queries" in text
