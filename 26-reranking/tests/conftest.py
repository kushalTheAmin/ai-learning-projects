import pytest

from reranking.data import load_corpus, load_queries
from reranking.evaluate import Evaluator


@pytest.fixture(scope="session")
def docs():
    return load_corpus()


@pytest.fixture(scope="session")
def queries():
    return load_queries()


@pytest.fixture(scope="session")
def evaluator(docs, queries):
    return Evaluator(docs, queries)
