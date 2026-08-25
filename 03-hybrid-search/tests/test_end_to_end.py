"""Integration tests over the real committed dataset: the full index →
retrieve → fuse → score path, plus the headline claims the README makes."""

import json
import subprocess
import sys
from pathlib import Path

import pytest

from hybrid_search.evaluate import aggregate, evaluate, load_json, sweep_alpha

PROJECT_DIR = Path(__file__).parent.parent
DATA_DIR = PROJECT_DIR / "data"


@pytest.fixture(scope="module")
def corpus():
    return load_json(DATA_DIR / "corpus.json")


@pytest.fixture(scope="module")
def queries():
    return load_json(DATA_DIR / "queries.json")


@pytest.fixture(scope="module")
def results(corpus, queries):
    return evaluate(corpus, queries)


def test_dataset_is_well_formed(corpus, queries):
    doc_ids = [d["id"] for d in corpus]
    assert len(doc_ids) == len(set(doc_ids))
    assert all(d["title"] and d["text"] for d in corpus)
    query_ids = [q["id"] for q in queries]
    assert len(query_ids) == len(set(query_ids))
    for q in queries:
        assert q["category"] in ("keyword", "paraphrase")
        assert q["relevant"], f"query {q['id']} has no relevant docs"
        assert set(q["relevant"]) <= set(doc_ids)


def test_every_query_produces_full_rankings(results, corpus):
    for r in results:
        for ranking in r.rankings.values():
            assert len(ranking) == len(corpus)
            assert len(set(ranking)) == len(corpus)


def test_keyword_queries_are_easy_for_both_retrievers(results):
    table = aggregate(results, "keyword")
    assert table["bm25"]["mrr"] == 1.0
    assert table["dense"]["mrr"] == 1.0


def test_dense_beats_bm25_on_paraphrase_recall(results):
    table = aggregate(results, "paraphrase")
    assert table["dense"]["recall@5"] >= table["bm25"]["recall@5"]
    assert table["dense"]["mrr"] > table["bm25"]["mrr"]


def test_hybrid_rrf_is_best_or_tied_overall(results):
    table = aggregate(results)
    best_single = max(table["bm25"]["mrr"], table["dense"]["mrr"])
    assert table["hybrid_rrf"]["mrr"] >= best_single - 1e-9


def test_all_strategies_clear_a_quality_floor(results):
    table = aggregate(results)
    for strategy, row in table.items():
        assert row["recall@5"] >= 0.85, f"{strategy} recall@5 too low"
        assert row["mrr"] >= 0.80, f"{strategy} mrr too low"


def test_evaluation_is_deterministic(corpus, queries):
    a = aggregate(evaluate(corpus, queries))
    b = aggregate(evaluate(corpus, queries))
    assert a == b


def test_unknown_relevant_doc_id_raises(corpus):
    bad = [{"id": "q", "query": "x", "relevant": ["nope-99"], "category": "keyword"}]
    with pytest.raises(ValueError):
        evaluate(corpus, bad)


def test_duplicate_corpus_ids_raise(corpus, queries):
    with pytest.raises(ValueError):
        evaluate(corpus + [corpus[0]], queries)


def test_alpha_sweep_covers_requested_alphas(corpus, queries):
    alphas = [0.0, 0.5, 1.0]
    sweep = sweep_alpha(corpus, queries, alphas)
    assert sorted(sweep) == alphas
    assert all(0.0 <= v <= 1.0 for v in sweep.values())


def test_entry_point_runs_and_prints_report():
    proc = subprocess.run(
        [sys.executable, str(PROJECT_DIR / "main.py")],
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert proc.returncode == 0, proc.stderr
    for marker in ("ALL QUERIES", "KEYWORD QUERIES", "PARAPHRASE QUERIES",
                   "ALPHA SWEEP", "recall@1", "mrr"):
        assert marker in proc.stdout
