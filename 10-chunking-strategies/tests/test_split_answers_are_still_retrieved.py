"""The retrieval half of the containment cliff.

A split answer scores zero by construction: no chunk contains it, the
relevant set is empty, and every rank metric reads 0 without consulting
the ranking. That is a statement about the metric, not about what the
retriever surfaced. These pin the measurement the project was missing —
the rank of the chunk holding the largest piece of the answer, the same
chunk the 71.1% coverage figure is read off — and the counts the README
quotes from it.
"""

import re
import subprocess
import sys
from pathlib import Path

from chunking.chunkers import fixed_chunks, sentence_chunks
from chunking.corpus import Doc, Query, load_docs, load_queries, validate
from chunking.evaluate import evaluate_config

ROOT = Path(__file__).parent.parent
DATA = ROOT / "data"


def load():
    docs = load_docs(DATA / "corpus.jsonl")
    queries = load_queries(DATA / "queries.jsonl")
    validate(docs, queries)
    return docs, queries


def fixed(size, overlap=0):
    return lambda d, t: fixed_chunks(d, t, size=size, overlap=overlap)


def normalized(path):
    return " ".join(path.read_text(encoding="utf-8").split())


def normalized_without_fixes(path):
    """The README minus its version history.

    The `## fixes` entries quote the claims they retired, so a ban on a
    retired sentence has to exempt the log that records retiring it.
    """
    text = path.read_text(encoding="utf-8")
    body = re.sub(r"\n## fixes\n.*?(?=\n## )", "\n", text, flags=re.DOTALL)
    assert "## fixes" not in body
    return " ".join(body.split())


def test_split_answers_best_chunk_is_usually_retrieved():
    # the finding: "the retriever never got a chunk worth ranking" is false
    # for 14 of fixed-80's 17 split answers. the chunk carrying most of the
    # answer lands in the top 5 anyway, and at rank 1 for 7 of them.
    docs, queries = load()
    result = evaluate_config("f80", docs, queries, fixed(80))
    splits = [r for r in result.per_query if r.answer_split]
    assert len(splits) == 17
    ranked_top5 = [r for r in splits if r.best_chunk_rank is not None and r.best_chunk_rank <= 5]
    ranked_first = [r for r in splits if r.best_chunk_rank == 1]
    assert len(ranked_top5) == 14
    assert len(ranked_first) == 7
    # and every one of them still scores a flat zero, which is the point
    for r in splits:
        assert r.rr_at_k == 0.0 and not r.hit_at_k


def test_the_same_holds_at_the_other_fixed_sizes():
    docs, queries = load()
    for size, expected_top5, expected_first in ((40, 16, 9), (160, 8, 5)):
        result = evaluate_config(f"f{size}", docs, queries, fixed(size))
        splits = [r for r in result.per_query if r.answer_split]
        top5 = sum(1 for r in splits if r.best_chunk_rank is not None and r.best_chunk_rank <= 5)
        first = sum(1 for r in splits if r.best_chunk_rank == 1)
        assert (top5, first) == (expected_top5, expected_first), size


def test_best_chunk_rank_indexes_the_reported_ranking():
    docs, queries = load()
    for chunker in (fixed(40), fixed(80), fixed(80, 20), lambda d, t: sentence_chunks(d, t, budget=80)):
        result = evaluate_config("c", docs, queries, chunker)
        for r in result.per_query:
            if r.best_chunk_rank is None:
                assert r.best_chunk_id not in r.ranked_chunk_ids
            else:
                assert r.ranked_chunk_ids[r.best_chunk_rank - 1] == r.best_chunk_id


def test_best_chunk_id_is_the_chunk_the_coverage_is_read_off():
    # the rank and the 71.1% figure must describe the same chunk, or the
    # readme's two sentences are about two different objects
    text = " ".join(f"w{i}" for i in range(20))
    doc = Doc(id="d", title="D", text=text)
    query = Query(id="q", query="w6 w7", doc_id="d", answer="w6 w7 w8 w9", category="keyword")
    result = evaluate_config("f", [doc], [query], lambda d, t: fixed_chunks(d, t, size=4))
    r = result.per_query[0]
    assert r.answer_split
    # windows are w0-w3, w4-w7, w8-w11: the answer straddles the last two
    # and "w6 w7" is the half that shares terms with the query
    assert r.best_chunk_id == "d#1"
    assert r.best_coverage == len("w6 w7") / len("w6 w7 w8 w9")
    assert r.best_chunk_rank == 1


def test_rank_is_none_when_the_covering_chunk_is_not_retrieved():
    doc = Doc(id="d", title="D", text="alpha beta gamma delta epsilon zeta eta theta")
    query = Query(id="q", query="zeta", doc_id="d", answer="gamma delta epsilon", category="keyword")
    # size-2 windows split the answer; the best-covering chunk is
    # "gamma delta", which shares no term with the query "zeta", so BM25
    # never returns it
    result = evaluate_config("f", [doc], [query], lambda d, t: fixed_chunks(d, t, size=2))
    r = result.per_query[0]
    assert r.answer_split
    assert r.best_chunk_id == "d#1"
    assert r.best_chunk_rank is None


def test_whole_answers_rank_exactly_where_the_reciprocal_rank_says():
    # with no overlap each answer has one relevant chunk, so the
    # best-covering chunk is that chunk and the two agree
    docs, queries = load()
    result = evaluate_config("f80", docs, queries, fixed(80))
    for r in result.per_query:
        if r.answer_split:
            continue
        assert r.best_coverage == 1.0
        assert r.relevant_chunk_ids == [r.best_chunk_id]
        expected = 1.0 / r.best_chunk_rank if r.best_chunk_rank else 0.0
        assert r.rr_at_k == expected


def test_entry_point_reports_the_retrieved_split_chunks():
    out = subprocess.run(
        [sys.executable, "main.py"], cwd=ROOT, capture_output=True, text=True, check=True
    ).stdout
    for name, top5, first in (("fixed-40", 16, 9), ("fixed-80", 14, 7), ("fixed-160", 8, 5)):
        block = re.search(
            rf"^{re.escape(name)}: (\d+)/40 answers split.*?\n.*?\n\s*the best chunk was "
            rf"retrieved anyway for (\d+) of them at k=5, (\d+) at rank 1$",
            out,
            re.MULTILINE,
        )
        assert block is not None, name
        assert (int(block.group(2)), int(block.group(3))) == (top5, first), name


def test_readme_drops_the_refuted_claim():
    body = normalized_without_fixes(ROOT / "README.md")
    assert "the retriever never got a chunk worth ranking" not in body
    root = normalized(ROOT.parent / "README.md")
    assert "before ranking gets a vote" not in root


def test_readme_quotes_the_measured_counts():
    readme = normalized(ROOT / "README.md")
    assert "14 of the 17 land in the top 5 anyway, 7 of them at rank 1" in readme
    # and the containment-cliff caveat no longer sends the whole question
    # to a model when half of it is answered above
    assert "measuring that needs a model in the loop" not in readme
