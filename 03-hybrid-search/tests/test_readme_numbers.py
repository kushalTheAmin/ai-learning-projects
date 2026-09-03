"""The README's "the numbers" block is quoted as the entry point's report,
so it has to be the entry point's report: every strategy main.py prints,
with the values it prints. These run main.py and diff the two.
"""

import re
import subprocess
import sys
from pathlib import Path

import pytest

PROJECT_DIR = Path(__file__).parent.parent
README = PROJECT_DIR / "README.md"

# "label   0.812   0.950   0.882" in either the readme's spacing or main.py's
ROW_RE = re.compile(
    r"^(?P<label>\S.*?)\s{2,}"
    r"(?P<recall1>\d\.\d{3})\s+(?P<recall5>\d\.\d{3})\s+(?P<mrr>\d\.\d{3})$"
)


def _section_of(header: str) -> str | None:
    if "KEYWORD" in header:
        return "keyword"
    if "PARAPHRASE" in header:
        return "paraphrase"
    if "ALL QUERIES" in header:
        return "all"
    return None


def _parse_tables(lines: list[str]) -> dict[str, dict[str, tuple[str, str, str]]]:
    """{section: {strategy label: (recall@1, recall@5, mrr)}} from printed rows."""
    tables: dict[str, dict[str, tuple[str, str, str]]] = {}
    current = None
    for line in lines:
        stripped = line.strip()
        if not stripped:
            # a table ends at its blank line, so the alpha sweep's own row of
            # numbers further down cannot be read as one more strategy
            current = None
            continue
        section = _section_of(stripped)
        if section is not None:
            current = tables.setdefault(section, {})
            continue
        match = ROW_RE.match(stripped)
        if match and current is not None and ":" not in match["label"]:
            current[match["label"]] = (
                match["recall1"],
                match["recall5"],
                match["mrr"],
            )
    return tables


def _numbers_block() -> list[str]:
    """The fenced block under "## the numbers", nothing else in the readme."""
    text = README.read_text(encoding="utf-8")
    body = text.split("## the numbers", 1)
    assert len(body) == 2, "readme has no '## the numbers' section"
    fenced = body[1].split("```")
    assert len(fenced) >= 3, "the numbers section has no fenced block"
    return fenced[1].splitlines()


def _numbers_prose() -> str:
    """The bullets between the fenced block and the next heading, whitespace
    normalized so a line wrap cannot decide whether a test passes."""
    text = README.read_text(encoding="utf-8")
    after_fence = text.split("## the numbers", 1)[1].split("```")[2]
    prose = after_fence.split("\n## ", 1)[0]
    return " ".join(prose.split())


@pytest.fixture(scope="module")
def printed_tables():
    proc = subprocess.run(
        [sys.executable, str(PROJECT_DIR / "main.py")],
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert proc.returncode == 0, proc.stderr
    tables = _parse_tables(proc.stdout.splitlines())
    assert set(tables) == {"all", "keyword", "paraphrase"}
    assert all(tables.values()), "parsed an empty table out of main.py's output"
    return tables


@pytest.fixture(scope="module")
def readme_tables():
    return _parse_tables(_numbers_block())


@pytest.mark.parametrize("section", ["all", "paraphrase"])
def test_readme_quotes_every_strategy_the_entry_point_prints(
    printed_tables, readme_tables, section
):
    # dropping a strategy from a table labelled as the run turns the block
    # into a selection, and the one that gets dropped is the one that loses
    assert set(readme_tables[section]) == set(printed_tables[section])


@pytest.mark.parametrize("section", ["all", "paraphrase"])
def test_readme_numbers_match_the_entry_point(
    printed_tables, readme_tables, section
):
    for label, printed in printed_tables[section].items():
        assert readme_tables[section].get(label) == printed, label


def test_weighted_fusion_row_is_the_default_alpha(readme_tables):
    # the row has to name the alpha it was measured at, or it reads as "the"
    # weighted blend rather than one point on the sweep
    from hybrid_search.evaluate import DEFAULT_ALPHA

    labels = set(readme_tables["all"])
    weighted = [label for label in labels if "weighted" in label]
    assert len(weighted) == 1, labels
    assert str(DEFAULT_ALPHA) in weighted[0]


def test_readme_says_where_the_weighted_blend_lands():
    # the numbers alone leave the reader to notice that the second fusion
    # strategy loses to plain dense; the section has to say it
    prose = _numbers_prose()
    assert "weighted" in prose
    assert "0.887" in prose and "0.774" in prose
