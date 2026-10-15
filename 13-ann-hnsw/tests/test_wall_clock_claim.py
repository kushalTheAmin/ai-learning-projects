"""The wall-clock section publishes no result, and does not call the race a tie.

At n=3000 the exact scan is one vectorized numpy pass while hnsw walks a few
hundred nodes through the interpreter, so hnsw loses on the clock even though
it wins by 15x on distance computations. The project used to publish one run's
pair (0.339 vs 0.328 ms/query), call its variance "a few percent run to run",
and state the outcome as a near-tie in both this readme and the root index
row. Repeated runs of this committed code put hnsw ef=32 between 0.44 and
0.97 ms/query against 0.39 to 0.55 for the exact scan, so the pair is not
reproducible, the spread is ~2x rather than a few percent, and the direction
is a loss rather than a tie.

These tests bind the prose on both sides: the retired figures and the tie
framing stay gone, and the claims that survived the fix — the distance count
as the portable number, the 15x that is a distance ratio and not a speedup —
stay said.
"""

import re
from pathlib import Path

_PROJECT = Path(__file__).resolve().parents[1]
README = _PROJECT / "README.md"
ROOT_README = _PROJECT.parent / "README.md"


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text)


def readme_without_fixes() -> str:
    """The readme with `## fixes` cut out: a fix entry quotes the sentence it
    retired, so a prose test has to read around it."""
    text = README.read_text()
    start = text.index("\n## fixes\n")
    end = text.index("\n## ", start + 1)
    return normalize(text[:start] + text[end:])


def root_index_row() -> str:
    rows = [
        line
        for line in ROOT_README.read_text().splitlines()
        if line.startswith("| 13 |")
    ]
    assert len(rows) == 1, f"expected exactly one root index row for 13, got {len(rows)}"
    return normalize(rows[0])


# -- the retired claims stay retired --------------------------------------


def test_the_one_run_pair_is_no_longer_published() -> None:
    text = readme_without_fixes()
    assert "0.339" not in text
    assert "0.328" not in text


def test_the_variance_is_not_described_as_a_few_percent() -> None:
    text = readme_without_fixes()
    assert "move a few percent run to run" not in text
    assert "a few percent" not in text


def test_neither_readme_calls_the_wall_clock_a_tie() -> None:
    text = readme_without_fixes()
    assert "near a tie" not in text
    assert "near-tie" not in text
    row = root_index_row()
    assert "near-tie" not in row
    assert "near a tie" not in row


# -- the corrected claim is said ------------------------------------------


def test_the_readme_names_the_direction_as_a_loss() -> None:
    text = readme_without_fixes()
    assert "hnsw was slower" in text
    # the range is published as observations, the way 05 publishes its replay
    # clock, not as a bound
    assert "observations on one machine, not a bound" in text


def test_the_root_row_names_the_direction_as_a_loss() -> None:
    row = root_index_row()
    assert "slower than numpy's vectorized full scan" in row


# -- and the claims the fix must not delete -------------------------------


def test_the_portable_claim_survives() -> None:
    text = readme_without_fixes()
    assert "the distance count is the portable number" in text
    assert (
        "the honest claim is 15x fewer distance computations, not 15x faster in "
        "this runtime" in text
    )


def test_the_interpreter_overhead_mechanism_survives() -> None:
    text = readme_without_fixes()
    assert "the exact scan is one vectorized numpy pass" in text
    assert "hnsw pays python-level overhead per visited node" in text
