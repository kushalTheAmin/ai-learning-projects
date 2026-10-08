"""The one number this README quotes from another project.

Everything else in the README comes out of `main.py`, which the integration
tests already pin. The open questions compare int8's recall cost against
13-ann-hnsw's ef knob, and that comparison is read off 13's published sweep
rather than computed here. Nothing else would notice if either side drifted,
so this binds the quoted pair to 13's table.
"""

import re
from pathlib import Path

_PROJECT = Path(__file__).resolve().parents[1]
_ANN_README = _PROJECT.parent / "13-ann-hnsw" / "README.md"

# "13 showed hnsw ef A to B buys P points (...) for Mx the distance budget"
_EF_CLAIM = re.compile(
    r"13 showed hnsw ef (\d+) to (\d+) buys ([\d.]+) points"
    r".*?for ([\d.]+)x the distance budget"
)
# the recall pair and the postings pair, published so they are checkable
_RECALL_PAIR = re.compile(r"buys [\d.]+ points \((\d\.\d{3}) to (\d\.\d{3})\)")
_DISTS_PAIR = re.compile(r"distance budget \((\d+) to (\d+) per query\)")


def _ef_sweep() -> dict[int, tuple[str, int]]:
    """13's published ef sweep: ef -> (recall@10 as printed, dists/query)."""
    text = _ANN_README.read_text(encoding="utf-8")
    block = re.search(
        r"^ef\s+recall@10\s+dists/query\s+vs exact\s*$(.*?)^```",
        text,
        re.MULTILINE | re.DOTALL,
    )
    assert block is not None, f"no ef sweep table in {_ANN_README}"
    rows = re.findall(r"^(\d+)\s+(\d\.\d{3})\s+(\d+)\s", block.group(1), re.MULTILINE)
    assert len(rows) >= 2, f"ef sweep table has {len(rows)} rows"
    return {int(ef): (recall, int(dists)) for ef, recall, dists in rows}


def test_ef_comparison_matches_13s_published_sweep():
    readme = (_PROJECT / "README.md").read_text(encoding="utf-8")
    claim = _EF_CLAIM.search(readme)
    assert claim is not None, "the open questions no longer quote 13's ef sweep"
    lo_ef, hi_ef = int(claim.group(1)), int(claim.group(2))
    quoted_points, quoted_multiple = float(claim.group(3)), float(claim.group(4))

    sweep = _ef_sweep()
    assert lo_ef in sweep and hi_ef in sweep, f"ef {lo_ef}/{hi_ef} not in 13's sweep"
    lo_recall, lo_dists = sweep[lo_ef]
    hi_recall, hi_dists = sweep[hi_ef]

    points = (float(hi_recall) - float(lo_recall)) * 100.0
    multiple = hi_dists / lo_dists
    assert round(points, 1) == quoted_points, (
        f"ef {lo_ef} to {hi_ef} buys {points:.1f} points in 13's table, "
        f"the readme says {quoted_points}"
    )
    assert round(multiple, 1) == quoted_multiple, (
        f"ef {lo_ef} to {hi_ef} costs {multiple:.1f}x in 13's table, "
        f"the readme says {quoted_multiple}x"
    )


def test_ef_comparison_publishes_the_pairs_it_derives_from():
    readme = (_PROJECT / "README.md").read_text(encoding="utf-8")
    claim = _EF_CLAIM.search(readme)
    assert claim is not None, "the open questions no longer quote 13's ef sweep"
    lo_ef, hi_ef = int(claim.group(1)), int(claim.group(2))
    sweep = _ef_sweep()

    recalls = _RECALL_PAIR.search(readme)
    assert recalls is not None, "the recall pair behind the points gap is not quoted"
    assert (recalls.group(1), recalls.group(2)) == (sweep[lo_ef][0], sweep[hi_ef][0])

    dists = _DISTS_PAIR.search(readme)
    assert dists is not None, "the distance pair behind the multiple is not quoted"
    assert (int(dists.group(1)), int(dists.group(2))) == (sweep[lo_ef][1], sweep[hi_ef][1])


def test_ef_comparison_prices_the_target_at_its_cheapest_row():
    """The upper endpoint has to be the cheapest row that reaches the recall
    it is quoted for.

    The sentence exists to price the ef knob against int8's 1.5 recall points,
    so the budget it names is the budget of hitting the recall it names. 13's
    sweep reaches 1.000 twice — ef 160 at 581 dists/query and ef 320 at 1221 —
    and the two existing tests above pass for either, because they only check
    the quoted figures against whichever pair the sentence names. Naming the
    later row doubles the quoted price of the same recall.
    """
    readme = (_PROJECT / "README.md").read_text(encoding="utf-8")
    claim = _EF_CLAIM.search(readme)
    assert claim is not None, "the open questions no longer quote 13's ef sweep"
    hi_ef = int(claim.group(2))

    recalls = _RECALL_PAIR.search(readme)
    assert recalls is not None, "the recall pair behind the points gap is not quoted"
    target = float(recalls.group(2))

    sweep = _ef_sweep()
    reaching = {
        ef: dists for ef, (recall, dists) in sweep.items() if float(recall) >= target
    }
    assert reaching, f"no row in 13's sweep reaches recall {target:.3f}"
    cheapest = min(reaching, key=lambda ef: (reaching[ef], ef))
    assert hi_ef == cheapest, (
        f"the readme prices recall {target:.3f} at ef {hi_ef} "
        f"({sweep[hi_ef][1]} dists/query), but 13's sweep already reaches it at "
        f"ef {cheapest} ({reaching[cheapest]} dists/query) — "
        f"{sweep[hi_ef][1] / reaching[cheapest]:.1f}x the budget for the same recall"
    )
