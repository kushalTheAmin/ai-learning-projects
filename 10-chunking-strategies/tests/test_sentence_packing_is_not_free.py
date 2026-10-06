"""The cost side of sentence packing, which the headline claim denied.

"sentence packing costs nothing and fixes all of it" was read off three
columns that are all true (same index size, 0% splits, better aggregate
mrr) and one that was never measured: what packing does to the answers
fixed chunking already kept whole. Packing redraws every chunk, not only
the ones that were cutting an answer, so a chunk drawn on sentence
boundaries can carry fewer of the query's other terms than the arbitrary
window did. These pin that drag, the recovery it is netted against, and
the mechanism behind it.
"""

import re
import subprocess
import sys
from pathlib import Path

from chunking.chunkers import fixed_chunks, sentence_chunks, word_count
from chunking.corpus import load_docs, load_queries, validate
from chunking.evaluate import evaluate_config
from chunking.retrieval import mean, tokenize

ROOT = Path(__file__).parent.parent
DATA = ROOT / "data"


def load():
    docs = load_docs(DATA / "corpus.jsonl")
    queries = load_queries(DATA / "queries.jsonl")
    validate(docs, queries)
    return docs, queries


def paired(size):
    """fixed-`size` and sentence-`size` results keyed by query id."""
    docs, queries = load()
    f = evaluate_config("f", docs, queries, lambda d, t: fixed_chunks(d, t, size=size))
    s = evaluate_config("s", docs, queries, lambda d, t: sentence_chunks(d, t, budget=size))
    return (
        f,
        s,
        {r.query.id: r for r in f.per_query},
        {r.query.id: r for r in s.per_query},
    )


def subsets(by_fixed):
    whole = sorted(q for q, r in by_fixed.items() if not r.answer_split)
    cut = sorted(q for q, r in by_fixed.items() if r.answer_split)
    return whole, cut


def test_packing_is_worse_on_the_answers_fixed_chunking_already_kept_whole():
    # the control the "costs nothing" claim needed: restrict to the queries
    # where fixed chunking cut nothing, so there is no boundary damage for
    # packing to repair, and packing loses mrr@10 at every budget.
    for size in (40, 80, 160):
        _, _, f, s = paired(size)
        whole, _ = subsets(f)
        fixed_mrr = mean([f[q].rr_at_k for q in whole])
        sent_mrr = mean([s[q].rr_at_k for q in whole])
        assert sent_mrr < fixed_mrr, (size, fixed_mrr, sent_mrr)


def test_hit_at_1_confirms_the_drag_at_80_and_160_and_contradicts_it_at_40():
    # not one metric's quirk at the two larger budgets, where the drag is
    # material — but budget 40 moves the other way, so the drag is only
    # claimed as an mrr effect there. pinned so neither direction drifts.
    falls = {80: (0.696, 0.609), 160: (0.767, 0.700)}
    for size, (fixed_h1, sent_h1) in falls.items():
        _, _, f, s = paired(size)
        whole, _ = subsets(f)
        got_fixed = mean([1.0 if f[q].hit_at_1 else 0.0 for q in whole])
        got_sent = mean([1.0 if s[q].hit_at_1 else 0.0 for q in whole])
        assert round(got_fixed, 3) == fixed_h1, (size, got_fixed)
        assert round(got_sent, 3) == sent_h1, (size, got_sent)
        assert got_sent < got_fixed, size
    _, _, f, s = paired(40)
    whole, _ = subsets(f)
    assert round(mean([1.0 if f[q].hit_at_1 else 0.0 for q in whole]), 3) == 0.692
    assert round(mean([1.0 if s[q].hit_at_1 else 0.0 for q in whole]), 3) == 0.769


def test_the_drag_at_each_budget_is_the_published_one():
    expected = {
        40: (13, 0.808, 0.803, -0.004),
        80: (23, 0.774, 0.683, -0.090),
        160: (30, 0.853, 0.817, -0.036),
    }
    for size, (n_whole, fixed_mrr, sent_mrr, delta) in expected.items():
        _, _, f, s = paired(size)
        whole, _ = subsets(f)
        assert len(whole) == n_whole, size
        got_fixed = mean([f[q].rr_at_k for q in whole])
        got_sent = mean([s[q].rr_at_k for q in whole])
        assert round(got_fixed, 3) == fixed_mrr, (size, got_fixed)
        assert round(got_sent, 3) == sent_mrr, (size, got_sent)
        assert round(got_sent - got_fixed, 3) == delta, (size, got_sent - got_fixed)


def test_the_headline_gain_decomposes_into_recovery_minus_drag():
    # the two halves must sum to the aggregate move, or the split is a story
    # rather than arithmetic
    for size, recovery, drag in ((40, 0.297, -0.001), (80, 0.305, -0.052), (160, 0.158, -0.027)):
        f_res, s_res, f, s = paired(size)
        whole, cut = subsets(f)
        n = len(f)
        got_recovery = len(cut) * mean([s[q].rr_at_k for q in cut]) / n
        got_drag = (
            len(whole)
            * (mean([s[q].rr_at_k for q in whole]) - mean([f[q].rr_at_k for q in whole]))
            / n
        )
        assert round(got_recovery, 3) == recovery, (size, got_recovery)
        assert round(got_drag, 3) == drag, (size, got_drag)
        assert abs((got_recovery + got_drag) - (s_res.mrr_at_k - f_res.mrr_at_k)) < 1e-12, size
        # fixed chunking scores a flat zero on everything it cut, so the
        # recovery term is packing's whole score there
        assert all(f[q].rr_at_k == 0.0 for q in cut), size


def test_the_eighty_pair_hands_back_a_sixth_of_what_it_wins():
    f_res, s_res, f, s = paired(80)
    whole, cut = subsets(f)
    assert (len(whole), len(cut)) == (23, 17)
    assert round(s_res.mrr_at_k - f_res.mrr_at_k, 3) == 0.253
    drag = (
        len(whole)
        * (mean([s[q].rr_at_k for q in whole]) - mean([f[q].rr_at_k for q in whole]))
        / len(f)
    )
    recovery = len(cut) * mean([s[q].rr_at_k for q in cut]) / len(f)
    assert round(-drag / recovery, 2) == 0.17


def test_the_mechanism_is_a_smaller_chunk_holding_fewer_query_terms():
    docs, _ = load()
    _, _, f, s = paired(80)
    whole, _ = subsets(f)
    fixed_chunk, sent_chunk = {}, {}
    for d in docs:
        for c in fixed_chunks(d.id, d.text, size=80):
            fixed_chunk[c.id] = c
        for c in sentence_chunks(d.id, d.text, budget=80):
            sent_chunk[c.id] = c
    # with no overlap each whole answer has exactly one relevant chunk
    fixed_words = mean([float(word_count(fixed_chunk[f[q].relevant_chunk_ids[0]].text)) for q in whole])
    sent_words = mean([float(word_count(sent_chunk[s[q].relevant_chunk_ids[0]].text)) for q in whole])
    assert round(fixed_words, 1) == 80.0
    assert round(sent_words, 1) == 70.9

    # four of the 23 rank worse, three of them fall out of the top 10
    worse = [q for q in whole if s[q].rr_at_k < f[q].rr_at_k]
    better = [q for q in whole if s[q].rr_at_k > f[q].rr_at_k]
    dropped = [q for q in whole if f[q].rr_at_k > 0 and s[q].rr_at_k == 0.0]
    assert len(worse) == 4 and len(better) == 3
    assert dropped == ["q11", "q18", "q32"]


def test_q11_is_the_sharpest_case_and_the_chunk_lost_query_terms():
    # q11's answer lands in rate-limit-design#2 under both strategies, at
    # rank 1 under fixed-80 and nowhere in the top 10 under sentence-80:
    # the arbitrary window happened to span the terms the query asks with,
    # a sentence boundary puts them in the neighbouring group
    docs, queries = load()
    _, _, f, s = paired(80)
    assert f["q11"].relevant_chunk_ids == ["rate-limit-design#2"]
    assert s["q11"].relevant_chunk_ids == ["rate-limit-design#2"]
    assert f["q11"].best_chunk_rank == 1 and f["q11"].rr_at_k == 1.0
    assert s["q11"].best_chunk_rank is None and s["q11"].rr_at_k == 0.0

    q11 = next(q for q in queries if q.id == "q11")
    doc = next(d for d in docs if d.id == q11.doc_id)
    terms = set(tokenize(q11.query))
    window = next(c for c in fixed_chunks(doc.id, doc.text, size=80) if c.index == 2)
    packed = next(c for c in sentence_chunks(doc.id, doc.text, budget=80) if c.index == 2)
    assert q11.answer in window.text and q11.answer in packed.text
    assert len(terms & set(tokenize(window.text))) == 5
    assert len(terms & set(tokenize(packed.text))) == 2


def test_entry_point_prints_the_decomposition():
    out = subprocess.run(
        [sys.executable, "main.py"], cwd=ROOT, capture_output=True, text=True, check=True
    ).stdout
    assert "== is sentence packing free? ==" in out
    for size, n_whole, fixed_mrr, sent_mrr, delta, cut_mrr in (
        (40, 13, "0.808", "0.803", "-0.004", "0.440"),
        (80, 23, "0.774", "0.683", "-0.090", "0.718"),
        (160, 30, "0.853", "0.817", "-0.036", "0.633"),
    ):
        line = (
            rf"^fixed-{size} kept {n_whole}/40 answers whole: mrr@10 {fixed_mrr} -> {sent_mrr} "
            rf"under sentence-{size} \({delta}\); on the \d+ it cut, sentence-{size} "
            rf"scores {cut_mrr}$"
        )
        assert re.search(line, out, re.MULTILINE), (size, line)
    assert re.search(
        r"^\s+overall 0\.445 -> 0\.698 = \+0\.305 recovered on the cut answers, "
        r"-0\.052 given back on the whole ones$",
        out,
        re.MULTILINE,
    )
    assert re.search(
        r"^\s+the relevant chunk shrinks 80\.0 -> 70\.9 words on those 23, "
        r"4 rank worse, 3 fall out of the top 10$",
        out,
        re.MULTILINE,
    )


def normalized(path):
    return " ".join(path.read_text(encoding="utf-8").split())


def without_fixes(path):
    text = path.read_text(encoding="utf-8")
    body = re.sub(r"\n## fixes\n.*?(?=\n## )", "\n", text, flags=re.DOTALL)
    assert "## fixes" not in body
    return " ".join(body.split())


def test_readme_drops_the_costs_nothing_claim_and_quotes_the_drag():
    body = without_fixes(ROOT / "README.md")
    assert "sentence packing costs nothing" not in body
    assert "costs nothing and fixes all of it" not in body
    readme = normalized(ROOT / "README.md")
    assert "+0.305 recovered on the answers fixed-80 cut, -0.052 given back" in readme
    assert "0.774 to 0.683" in readme
