"""Scripted bridge-term extraction from a retrieved document.

The hop-1 document names the entity the answer document is filed under
(here, a service name). No model reads the doc; instead the extractor bets
that the bridge is whatever the doc talks about that the question does not:
score every term by tf * idf within the doc, drop terms the question
already contains, keep the top few. idf comes from the same BM25 index
that ranked the doc, so "distinctive" means distinctive in this corpus.

This is the same move as pseudo-relevance feedback, pointed at a two-hop
task, and it inherits the classic PRF failure: extract from the wrong doc
and the added terms drag hop 2 toward that wrong doc. The eval measures
that drift instead of hoping it away.
"""

from collections import Counter

from .reuse import BM25Index, tokenize


def extract_bridge_terms(
    doc_text: str,
    question: str,
    index: BM25Index,
    max_terms: int = 3,
) -> list[str]:
    if max_terms < 1:
        raise ValueError(f"max_terms must be >= 1, got {max_terms}")
    question_terms = set(tokenize(question))
    counts = Counter(tokenize(doc_text))
    scored = [
        (counts[term] * index.idf.get(term, 0.0), term)
        for term in counts
        if term not in question_terms
    ]
    scored = [(score, term) for score, term in scored if score > 0]
    scored.sort(key=lambda pair: (-pair[0], pair[1]))
    return [term for _, term in scored[:max_terms]]
