from query_rewriting.data import Query
from query_rewriting.generator import ScriptedHyde
from query_rewriting.reuse import BM25Index, tokenize
from query_rewriting.rewrite import hyde_append, hyde_replace, prf_expand, raw

BANK = {"q1": "alpha answer text", "q2": "other answer"}
QUERY = Query("q1", "some question", ("a",), "keyword")


def test_raw_is_a_passthrough():
    assert raw(QUERY) == "some question"


def test_hyde_append_keeps_the_query_and_adds_the_answer():
    hyde = ScriptedHyde(BANK, hallucination_rate=0.0)
    assert hyde_append(QUERY, hyde) == "some question alpha answer text"


def test_hyde_replace_drops_the_query():
    hyde = ScriptedHyde(BANK, hallucination_rate=0.0)
    assert hyde_replace(QUERY, hyde) == "alpha answer text"


def _tiny_index() -> tuple[dict[str, str], BM25Index]:
    docs = {
        "a": "alpha beta beta gamma",
        "b": "alpha delta",
        "c": "epsilon zeta",
    }
    return docs, BM25Index(docs)


def test_prf_appends_novel_terms_from_the_top_doc():
    docs, index = _tiny_index()
    query = Query("q1", "beta", ("a",), "keyword")
    expanded, source = prf_expand(query, docs, index, max_terms=2)
    assert source == "a"
    added = expanded[len(query.text) + 1 :].split()
    assert 1 <= len(added) <= 2
    query_terms = set(tokenize(query.text))
    doc_terms = set(tokenize(docs["a"]))
    for term in added:
        assert term in doc_terms
        assert term not in query_terms


def test_prf_leaves_an_unmatchable_query_alone():
    docs, index = _tiny_index()
    query = Query("q1", "unseen words only", ("a",), "keyword")
    expanded, source = prf_expand(query, docs, index, max_terms=3)
    assert expanded == query.text
    assert source is None


def test_prf_respects_max_terms_far_beyond_doc_vocabulary():
    docs, index = _tiny_index()
    query = Query("q1", "beta", ("a",), "keyword")
    expanded, source = prf_expand(query, docs, index, max_terms=1000)
    assert source == "a"
    added = set(expanded[len(query.text) + 1 :].split())
    assert added <= set(tokenize(docs["a"])) - {"beta"}


def test_prf_expansion_changes_the_search_string_deterministically():
    docs, index = _tiny_index()
    query = Query("q1", "beta", ("a",), "keyword")
    first = prf_expand(query, docs, index, max_terms=2)
    second = prf_expand(query, docs, index, max_terms=2)
    assert first == second
