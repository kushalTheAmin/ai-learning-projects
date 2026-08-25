import subprocess
import sys
from pathlib import Path

import pytest

from retrieval_eval.bm25 import BM25Index
from retrieval_eval.data import Query, load_corpus, load_queries
from retrieval_eval.evaluate import evaluate_system, head_to_head
from retrieval_eval.tfidf import TfidfIndex

PROJECT_DIR = Path(__file__).parent.parent
DATA_DIR = PROJECT_DIR / "data"


@pytest.fixture(scope="module")
def corpus():
    return load_corpus(DATA_DIR / "corpus.jsonl")


@pytest.fixture(scope="module")
def queries(corpus):
    return load_queries(DATA_DIR / "queries.jsonl", corpus)


def test_committed_dataset_is_valid(corpus, queries):
    assert len(corpus) >= 30
    assert len(queries) >= 25


def test_full_evaluation_over_committed_data(corpus, queries):
    for index in (BM25Index(corpus), TfidfIndex(corpus)):
        report = evaluate_system("system", index, queries, k_values=(1, 5), mrr_k=10)
        assert len(report.outcomes) == len(queries)
        assert 0.0 <= report.mrr <= 1.0
        for k, value in report.recall_at.items():
            assert 0.0 <= value <= 1.0
        # the committed dataset is mostly answerable by lexical search;
        # a broken scorer would land far below this floor
        assert report.mrr >= 0.8
        assert report.recall_at[5] >= 0.9


def test_evaluation_is_deterministic(corpus, queries):
    first = evaluate_system("bm25", BM25Index(corpus), queries)
    second = evaluate_system("bm25", BM25Index(corpus), queries)
    assert first == second


def test_head_to_head_accounts_for_every_query(corpus, queries):
    bm25 = evaluate_system("bm25", BM25Index(corpus), queries)
    tfidf = evaluate_system("tfidf", TfidfIndex(corpus), queries)
    versus = head_to_head(bm25, tfidf)
    assert len(versus.wins_a) + len(versus.wins_b) + versus.ties == len(queries)


def test_head_to_head_rejects_mismatched_query_lists(corpus):
    query_a = [Query(text="alpha", relevant=("git-revert",))]
    query_b = [Query(text="beta", relevant=("git-revert",))]
    report_a = evaluate_system("a", BM25Index(corpus), query_a)
    report_b = evaluate_system("b", BM25Index(corpus), query_b)
    with pytest.raises(ValueError, match="different query lists"):
        head_to_head(report_a, report_b)


def test_entry_point_runs_and_reports(corpus, queries):
    result = subprocess.run(
        [sys.executable, "main.py"],
        cwd=PROJECT_DIR,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, result.stderr
    out = result.stdout
    assert f"corpus: {len(corpus)} docs, {len(queries)} labeled queries" in out
    assert "recall@1" in out and "mrr@10" in out
    assert "tf-idf cosine" in out
    assert "bm25 (k1=1.5, b=0.75)" in out
    assert "head to head by reciprocal rank" in out
