"""The uncertainty on the packing drag, which "real everywhere" assumed away.

The 2026-10-06 fix measured what sentence packing costs on the answers
fixed chunking already kept whole and published the drag at three
budgets — -0.004, -0.090, -0.036 — as evidence that the cost "is real
everywhere". Two of those three survive resampling. The third does not:
at budget 40 the drag is the residue of two queries gaining a rank and
one losing eight, over a 13-query subset where 9 queries do not move at
all, and 02's paired bootstrap puts its sign at a coin flip. These pin
each budget's interval, the single query the budget-40 sign hangs on,
and the readme and entry point carrying the uncertainty.
"""

import re
import subprocess
import sys
from pathlib import Path

from chunking.chunkers import fixed_chunks, sentence_chunks
from chunking.corpus import load_docs, load_queries, validate
from chunking.evaluate import evaluate_config
from chunking.retrieval import mean, paired_bootstrap

ROOT = Path(__file__).parent.parent
DATA = ROOT / "data"

RESAMPLES = 10_000
SEED = 0


def drag_sample(size):
    """Per-query (packed, fixed) rr@10 on the answers fixed-`size` kept whole."""
    docs = load_docs(DATA / "corpus.jsonl")
    queries = load_queries(DATA / "queries.jsonl")
    validate(docs, queries)
    f = evaluate_config("f", docs, queries, lambda d, t: fixed_chunks(d, t, size=size))
    s = evaluate_config("s", docs, queries, lambda d, t: sentence_chunks(d, t, budget=size))
    by_fixed = {r.query.id: r for r in f.per_query}
    by_packed = {r.query.id: r for r in s.per_query}
    whole = [q for q, r in by_fixed.items() if not r.answer_split]
    return whole, [by_packed[q].rr_at_k for q in whole], [by_fixed[q].rr_at_k for q in whole]


def test_budget_40s_drag_is_a_coin_flip_and_80_and_160_are_not():
    # the claim was read off three point estimates with no uncertainty on
    # any of them. resampled, the three do not say the same thing: at 40
    # the sign is decided by the resample, at 80 and 160 it holds in ~95%.
    expected = {40: 50.0, 80: 5.2, 160: 4.8}
    for size, wrong_side in expected.items():
        _, packed, fixed = drag_sample(size)
        pc = paired_bootstrap(packed, fixed, RESAMPLES, seed=SEED)
        assert round(100 * pc.p_ge_zero, 1) == wrong_side, (size, pc.p_ge_zero)
    # a drag that lands on the wrong side of zero half the time is not a
    # measured cost, and the other two are not coin flips
    _, packed, fixed = drag_sample(40)
    assert paired_bootstrap(packed, fixed, RESAMPLES, seed=SEED).p_ge_zero > 0.45
    for size in (80, 160):
        _, packed, fixed = drag_sample(size)
        assert paired_bootstrap(packed, fixed, RESAMPLES, seed=SEED).p_ge_zero < 0.10


def test_no_budgets_interval_excludes_zero_at_40_queries():
    # the stronger reading the readme must not go back to: even at 80 and
    # 160 the interval straddles zero, so the drag is a direction that
    # survives resampling, never a magnitude this corpus has pinned down
    for size in (40, 80, 160):
        _, packed, fixed = drag_sample(size)
        ci = paired_bootstrap(packed, fixed, RESAMPLES, seed=SEED).ci
        assert ci.lo < 0.0 < ci.hi, (size, ci)


def test_the_published_intervals_are_the_ones_in_the_readme():
    expected = {
        40: (-0.004, -0.192, +0.154),
        80: (-0.090, -0.220, +0.016),
        160: (-0.036, -0.089, +0.003),
    }
    for size, (diff, lo, hi) in expected.items():
        _, packed, fixed = drag_sample(size)
        pc = paired_bootstrap(packed, fixed, RESAMPLES, seed=SEED)
        assert round(pc.diff, 3) == diff, (size, pc.diff)
        assert round(pc.ci.lo, 3) == lo, (size, pc.ci.lo)
        assert round(pc.ci.hi, 3) == hi, (size, pc.ci.hi)


def test_the_budget_40_sign_hangs_on_one_query():
    # 9 of the 13 do not move at all; of the 4 that do, two gain a full
    # rank and q19 alone loses eight. drop it and the drag changes sign,
    # which is what "real" cannot mean.
    whole, packed, fixed = drag_sample(40)
    moved = [(q, p - f) for q, p, f in zip(whole, packed, fixed) if abs(p - f) > 1e-12]
    assert len(whole) == 13 and len(moved) == 4
    assert sorted(q for q, _ in moved) == ["q08", "q19", "q24", "q29"]
    assert round(dict(moved)["q19"], 3) == -0.889
    assert sum(1 for _, d in moved if d > 0) == 2 and sum(1 for _, d in moved if d < 0) == 2

    drag = mean([p - f for p, f in zip(packed, fixed)])
    without_q19 = mean(
        [p - f for q, p, f in zip(whole, packed, fixed) if q != "q19"]
    )
    assert drag < 0.0 < without_q19
    assert round(drag, 3) == -0.004 and round(without_q19, 3) == 0.069


def test_both_directions_are_counted_at_every_budget():
    # the entry point priced the drag with a one-sided count ("4 rank
    # worse"), and at budget 40 the matching count is 2 against 2
    expected = {40: (2, 2), 80: (4, 3), 160: (3, 1)}
    for size, (worse, better) in expected.items():
        _, packed, fixed = drag_sample(size)
        assert sum(1 for p, f in zip(packed, fixed) if p < f) == worse, size
        assert sum(1 for p, f in zip(packed, fixed) if p > f) == better, size


def run_entry_point():
    return subprocess.run(
        [sys.executable, "main.py"], cwd=ROOT, capture_output=True, text=True, check=True
    ).stdout


def test_entry_point_publishes_the_interval_on_every_budgets_drag():
    out = run_entry_point()
    for size, diff, lo, hi, wrong in (
        (40, r"-0\.004", r"-0\.192", r"\+0\.154", r"50\.0"),
        (80, r"-0\.090", r"-0\.220", r"\+0\.016", r"5\.2"),
        (160, r"-0\.036", r"-0\.089", r"\+0\.003", r"4\.8"),
    ):
        line = (
            rf"^\s+the drag over those \d+, paired bootstrap over queries "
            rf"\({RESAMPLES} resamples, 95% ci\): {diff} \[{lo}, {hi}\] "
            rf">=0 in {wrong}% of resamples$"
        )
        assert re.search(line, out, re.MULTILINE), (size, line)
    # budget 40 is the only coin flip, and the entry point names the query
    # its sign belongs to so the leave-one-out is checkable from the output
    assert re.search(
        r"^\s+a coin flip at 50\.0% — the resample decides the sign, "
        r"so this budget measures no cost at all$",
        out,
        re.MULTILINE,
    )
    assert re.search(
        r"^\s+the sign hangs on q19 \(-0\.889 alone\): drop it and the drag "
        r"turns \+0\.069 over the other 12$",
        out,
        re.MULTILINE,
    )
    assert out.count("a coin flip at") == 1
    for holds in (r"94\.9", r"96\.6"):
        assert re.search(
            rf"^\s+the sign holds in {holds}% of resamples, the interval straddles zero "
            r"— a direction, not a magnitude$",
            out,
            re.MULTILINE,
        ), holds


def test_entry_point_prints_the_better_count_next_to_the_worse_one():
    out = run_entry_point()
    for size, worse, better in ((40, 2, 2), (80, 4, 3), (160, 3, 1)):
        assert re.search(
            rf"^\s+the relevant chunk shrinks [\d.]+ -> [\d.]+ words on those \d+, "
            rf"{worse} rank worse, {better} rank better, \d+ fall out of the top 10$",
            out,
            re.MULTILINE,
        ), (size, worse, better)


def test_the_entry_point_stays_byte_identical_across_runs():
    # the bootstrap is the only randomness in the project and it is seeded
    assert run_entry_point() == run_entry_point()


def without_fixes(path):
    text = path.read_text(encoding="utf-8")
    body = re.sub(r"\n## fixes\n.*?(?=\n## )", "\n", text, flags=re.DOTALL)
    assert "## fixes" not in body
    return " ".join(body.split())


def test_readme_drops_real_everywhere_and_names_the_coin_flip():
    body = without_fixes(ROOT / "README.md")
    assert "real everywhere" not in body
    assert "coin flip" in body
    assert "50.0% of resamples" in body
    for quoted in ("-0.090 [-0.220, +0.016]", "-0.004 [-0.192, +0.154]", "-0.036 [-0.089, +0.003]"):
        assert quoted in body, quoted


def test_readme_no_longer_says_the_bootstrap_was_not_run():
    body = without_fixes(ROOT / "README.md")
    assert "could put intervals on these gaps and was not run here" not in body
