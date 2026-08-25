import pytest

from retrieval_eval.data import load_corpus, load_queries


def write(path, text):
    path.write_text(text, encoding="utf-8")
    return path


def test_load_corpus_happy_path_with_blank_lines(tmp_path):
    path = write(
        tmp_path / "corpus.jsonl",
        '{"id": "d1", "title": "T1", "text": "body one"}\n'
        "\n"
        '{"id": "d2", "title": "T2", "text": "body two"}\n',
    )
    docs = load_corpus(path)
    assert docs == {"d1": "T1\nbody one", "d2": "T2\nbody two"}


def test_load_corpus_rejects_malformed_json_with_line_number(tmp_path):
    path = write(tmp_path / "corpus.jsonl", '{"id": "d1", "title": "T", "text": "x"}\n{broken\n')
    with pytest.raises(ValueError, match="line 2"):
        load_corpus(path)


def test_load_corpus_rejects_duplicate_ids(tmp_path):
    path = write(
        tmp_path / "corpus.jsonl",
        '{"id": "d1", "title": "T", "text": "x"}\n{"id": "d1", "title": "T", "text": "y"}\n',
    )
    with pytest.raises(ValueError, match="duplicate doc id"):
        load_corpus(path)


def test_load_corpus_rejects_missing_or_empty_fields(tmp_path):
    with pytest.raises(ValueError, match="'text'"):
        load_corpus(write(tmp_path / "a.jsonl", '{"id": "d1", "title": "T"}\n'))
    with pytest.raises(ValueError, match="'title'"):
        load_corpus(write(tmp_path / "b.jsonl", '{"id": "d1", "title": "  ", "text": "x"}\n'))


def test_load_corpus_rejects_empty_file(tmp_path):
    with pytest.raises(ValueError, match="empty"):
        load_corpus(write(tmp_path / "corpus.jsonl", "\n\n"))


def test_load_corpus_rejects_non_object_lines(tmp_path):
    with pytest.raises(ValueError, match="expected an object"):
        load_corpus(write(tmp_path / "corpus.jsonl", '["not", "an", "object"]\n'))


CORPUS = {"d1": "T1\nbody", "d2": "T2\nbody"}


def test_load_queries_happy_path(tmp_path):
    path = write(tmp_path / "queries.jsonl", '{"query": "find body", "relevant": ["d1", "d2"]}\n')
    queries = load_queries(path, CORPUS)
    assert len(queries) == 1
    assert queries[0].text == "find body"
    assert queries[0].relevant == ("d1", "d2")


def test_load_queries_rejects_unknown_relevant_id(tmp_path):
    path = write(tmp_path / "queries.jsonl", '{"query": "q", "relevant": ["ghost"]}\n')
    with pytest.raises(ValueError, match="not in corpus"):
        load_queries(path, CORPUS)


def test_load_queries_rejects_empty_relevant_list(tmp_path):
    path = write(tmp_path / "queries.jsonl", '{"query": "q", "relevant": []}\n')
    with pytest.raises(ValueError, match="non-empty list"):
        load_queries(path, CORPUS)


def test_load_queries_rejects_missing_query_text(tmp_path):
    path = write(tmp_path / "queries.jsonl", '{"relevant": ["d1"]}\n')
    with pytest.raises(ValueError, match="'query'"):
        load_queries(path, CORPUS)


def test_load_queries_rejects_empty_file(tmp_path):
    with pytest.raises(ValueError, match="no queries"):
        load_queries(write(tmp_path / "queries.jsonl", ""), CORPUS)
