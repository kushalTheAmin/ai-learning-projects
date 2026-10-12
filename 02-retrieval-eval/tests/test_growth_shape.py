"""The sweep summary asserted linear growth instead of measuring it.

`print_sweep` printed "both columns grow linearly in corpus size" and then
projected the last row's wall clock straight up to a million docs. The
inverted column really is linear. The flat column is not: it scans every
doc per query term *and* sorts all n scores per query, so on the committed
sweep it goes 0.910ms to 65.229ms while the corpus grows 32x — 71.7x, with
every single doubling costing more than 2x. Scaling the last row linearly
understates the flat scan at a million docs by better than two.

These tests read the committed table back out of the readme, so they bind
the published claim to the published numbers and need no wall clock of
their own.
"""

import re
from pathlib import Path

from scaling import (
    PROJECTION_DOCS,
    growth_exponent,
    project_at,
    sweep_summary,
)

README = Path(__file__).resolve().parent.parent / "README.md"
ROOT_README = Path(__file__).resolve().parent.parent.parent / "README.md"


def normalized(path: Path) -> str:
    """Readme as one whitespace-collapsed line, so a wrap cannot hide a claim."""
    return " ".join(path.read_text(encoding="utf-8").split())


def normalized_readme() -> str:
    return normalized(README)


def readme_claims() -> str:
    """Everything above `## fixes` — the history is allowed to name what it retired."""
    body, _, history = README.read_text(encoding="utf-8").partition("## fixes")
    assert history, "the fixes section is gone from the readme"
    return " ".join(body.split())


def readme_sweep_rows() -> list[tuple[int, float, float]]:
    """The committed corpus-size sweep, parsed back out as (docs, flat, inv)."""
    block = re.search(
        r"== corpus-size sweep, 200 typical queries per size ==.*?```", README.read_text(), re.S
    )
    assert block, "the corpus-size sweep is gone from the readme"
    rows = []
    for line in block.group(0).splitlines():
        cells = line.split()
        if len(cells) == 11 and cells[0].isdigit():
            # docs, build flat, build inv, flat ms, flat p95, inv ms, inv p95, ...
            rows.append((int(cells[0]), float(cells[3]), float(cells[5])))
    assert len(rows) == 6, rows
    return rows


def columns() -> tuple[list[int], list[float], list[float]]:
    rows = readme_sweep_rows()
    return [r[0] for r in rows], [r[1] for r in rows], [r[2] for r in rows]


# ------------------------------------------------ the exponent, on known shapes


def test_growth_exponent_reads_one_off_a_linear_column():
    sizes = [1_000, 2_000, 4_000, 8_000]
    assert abs(growth_exponent(sizes, [1.0, 2.0, 4.0, 8.0]) - 1.0) < 1e-9


def test_growth_exponent_reads_the_exponent_off_a_power_law():
    sizes = [1_000, 2_000, 4_000, 8_000]
    quadratic = [(n / 1_000) ** 2 for n in sizes]
    assert abs(growth_exponent(sizes, quadratic) - 2.0) < 1e-9
    n_log_n = [(n / 1_000) * (n / 1_000) ** 0.25 for n in sizes]
    assert abs(growth_exponent(sizes, n_log_n) - 1.25) < 1e-9


# ------------------------------------- the committed sweep is not two linear columns


def test_the_committed_flat_column_is_superlinear():
    sizes, flat, _ = columns()
    assert flat[0] == 0.910 and flat[-1] == 65.229
    # 32x the corpus costs 71.7x the time, not 32x
    assert flat[-1] / flat[0] > 2 * (sizes[-1] / sizes[0])
    assert growth_exponent(sizes, flat) > 1.15


def test_every_doubling_of_the_committed_flat_column_costs_more_than_two():
    """Not one noisy row — the whole column bends the same way."""
    _, flat, _ = columns()
    ratios = [flat[i + 1] / flat[i] for i in range(len(flat) - 1)]
    assert min(ratios) > 2.1, ratios


def test_the_committed_inverted_column_really_is_linear():
    sizes, _, inv = columns()
    assert abs(growth_exponent(sizes, inv) - 1.0) < 0.1


def test_a_linear_projection_understates_the_committed_flat_scan():
    sizes, flat, _ = columns()
    scale = PROJECTION_DOCS / sizes[-1]
    linear = flat[-1] * scale
    measured = project_at(sizes, flat, PROJECTION_DOCS)
    assert measured > 2 * linear
    assert round(linear / 1000, 1) == 2.0  # the retired number
    assert round(measured / 1000, 1) == 4.2


# ------------------------------------------------------- the summary says which


def test_the_sweep_summary_no_longer_claims_both_columns_are_linear():
    sizes, flat, inv = columns()
    summary = sweep_summary(sizes, flat, inv)
    assert "grow linearly" not in summary
    assert "linear" not in summary or "not linear" in summary


def test_the_sweep_summary_reports_each_measured_exponent_and_projection():
    sizes, flat, inv = columns()
    summary = sweep_summary(sizes, flat, inv)
    assert f"n^{growth_exponent(sizes, flat):.2f}" in summary
    assert f"n^{growth_exponent(sizes, inv):.2f}" in summary
    assert "~4.2s/query flat" in summary
    assert "~0.42s/query inverted" in summary


def test_the_readme_quotes_the_summary_the_committed_table_produces():
    """The fenced summary line is exactly what the table above it yields."""
    sizes, flat, inv = columns()
    assert sweep_summary(sizes, flat, inv) in normalized_readme()


# ------------------------------------------------------------- retired readings


def test_the_readme_does_not_call_the_flat_scan_linear():
    """Three retired claims, none allowed back in the prose."""
    text = readme_claims()
    assert "both columns grow linearly in corpus size" not in text
    assert "per-query latency is linear in corpus size" not in text
    assert "by 1M docs its ~2.0s per query" not in text


def test_the_readme_states_the_corrected_projection():
    text = normalized_readme()
    assert "~4.2s" in text


def test_the_root_index_row_does_not_call_the_full_scan_linear():
    text = normalized(ROOT_README)
    assert "the full scan degrades linearly" not in text
    assert "faster than linearly" in text
