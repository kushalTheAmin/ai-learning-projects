"""Rewrite strategies: each takes a query and returns the search string.

The index never changes; only the text handed to it does. BM25's scoring
counts each distinct query term once, so appending text is a union of
vocabularies — the original terms keep their votes and every added term
casts a new one, for the right docs or the wrong ones.
"""

from .data import Query
from .generator import ScriptedHyde
from .reuse import BM25Index, extract_bridge_terms


def raw(query: Query) -> str:
    return query.text


def hyde_append(query: Query, hyde: ScriptedHyde) -> str:
    return f"{query.text} {hyde.generate(query.query_id).text}"


def hyde_replace(query: Query, hyde: ScriptedHyde) -> str:
    return hyde.generate(query.query_id).text


def prf_expand(
    query: Query,
    docs: dict[str, str],
    index: BM25Index,
    max_terms: int,
) -> tuple[str, str | None]:
    """Pseudo-relevance feedback: append the top-scoring novel terms from
    the first search's best doc (23's extractor). Returns the expanded
    query and the doc id the terms came from — None when the first search
    matched nothing, in which case the query is returned unexpanded."""
    results = index.search(query.text, top_k=1)
    if not results:
        return query.text, None
    top_id = results[0][0]
    terms = extract_bridge_terms(docs[top_id], query.text, index, max_terms=max_terms)
    if not terms:
        return query.text, top_id
    return f"{query.text} {' '.join(terms)}", top_id
