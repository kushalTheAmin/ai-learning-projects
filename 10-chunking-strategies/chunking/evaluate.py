"""Evaluate one chunking configuration end to end.

The pipeline: chunk every document, index all chunks with 02's BM25,
run every gold query, and score against exact answer containment. A
chunk is relevant iff the full answer string appears in its text, so a
strategy that cuts an answer sentence across a boundary has an empty
relevant set for that query and scores zero — that is the failure mode
this project exists to measure, not an edge case to paper over.
"""

from dataclasses import dataclass
from typing import Callable

from .chunkers import Chunk, word_count
from .corpus import Doc, Query
from .retrieval import BM25Index, mean, reciprocal_rank

MRR_K = 10
HIT_K = 5
CONTEXT_K = 5


@dataclass(frozen=True)
class QueryResult:
    query: Query
    relevant_chunk_ids: list[str]
    ranked_chunk_ids: list[str]
    rr_at_k: float
    hit_at_1: bool
    hit_at_k: bool
    answer_split: bool  # no chunk of any doc contains the full answer
    best_chunk_id: str | None  # the chunk holding the largest piece of the answer
    best_coverage: float  # largest fraction of the answer inside any one chunk
    best_chunk_rank: int | None  # 1-indexed rank of that chunk, None if unranked
    context_words: int  # words in the top CONTEXT_K chunks


@dataclass(frozen=True)
class ConfigResult:
    name: str
    n_chunks: int
    mean_chunk_words: float
    index_words: int
    per_query: list[QueryResult]

    @property
    def split_rate(self) -> float:
        return mean([1.0 if r.answer_split else 0.0 for r in self.per_query])

    @property
    def hit_rate_at_1(self) -> float:
        return mean([1.0 if r.hit_at_1 else 0.0 for r in self.per_query])

    @property
    def hit_rate_at_k(self) -> float:
        return mean([1.0 if r.hit_at_k else 0.0 for r in self.per_query])

    @property
    def mrr_at_k(self) -> float:
        return mean([r.rr_at_k for r in self.per_query])

    @property
    def mean_context_words(self) -> float:
        return mean([float(r.context_words) for r in self.per_query])

    def misses_at_k(self) -> list[QueryResult]:
        return [r for r in self.per_query if not r.hit_at_k]


def chunk_corpus(docs: list[Doc], chunker: Callable[[str, str], list[Chunk]]) -> list[Chunk]:
    chunks: list[Chunk] = []
    for doc in docs:
        chunks.extend(chunker(doc.id, doc.text))
    return chunks


def evaluate_config(
    name: str,
    docs: list[Doc],
    queries: list[Query],
    chunker: Callable[[str, str], list[Chunk]],
) -> ConfigResult:
    chunks = chunk_corpus(docs, chunker)
    if not chunks:
        raise ValueError(f"{name}: chunker produced no chunks")
    texts = {chunk.id: chunk.text for chunk in chunks}
    index = BM25Index(texts)
    doc_texts = {doc.id: doc.text for doc in docs}
    per_query = [_score_query(q, chunks, texts, doc_texts, index) for q in queries]
    sizes = [word_count(chunk.text) for chunk in chunks]
    return ConfigResult(
        name=name,
        n_chunks=len(chunks),
        mean_chunk_words=mean([float(s) for s in sizes]),
        index_words=sum(sizes),
        per_query=per_query,
    )


def _score_query(
    query: Query,
    chunks: list[Chunk],
    texts: dict[str, str],
    doc_texts: dict[str, str],
    index: BM25Index,
) -> QueryResult:
    relevant = [chunk.id for chunk in chunks if query.answer in chunk.text]
    ranked = [chunk_id for chunk_id, _ in index.search(query.query, top_k=MRR_K)]
    if relevant:
        rr = reciprocal_rank(ranked, relevant, MRR_K)
        hit1 = reciprocal_rank(ranked, relevant, 1) > 0
        hitk = reciprocal_rank(ranked, relevant, HIT_K) > 0
    else:
        rr, hit1, hitk = 0.0, False, False
    context = sum(word_count(texts[chunk_id]) for chunk_id in ranked[:CONTEXT_K])
    best_id, best_coverage = _best_covering_chunk(query, chunks, doc_texts)
    return QueryResult(
        query=query,
        relevant_chunk_ids=relevant,
        ranked_chunk_ids=ranked,
        rr_at_k=rr,
        hit_at_1=hit1,
        hit_at_k=hitk,
        answer_split=not relevant,
        best_chunk_id=best_id,
        best_coverage=best_coverage,
        best_chunk_rank=(ranked.index(best_id) + 1 if best_id in ranked else None),
        context_words=context,
    )


def _best_covering_chunk(
    query: Query, chunks: list[Chunk], doc_texts: dict[str, str]
) -> tuple[str | None, float]:
    """The chunk holding the most of the answer, and how much of it.

    Coverage is 1.0 when some chunk contains the whole answer; below 1.0
    it measures how badly a boundary cut the answer — a split is rarely a
    clean 50/50, and the surviving majority piece is what a retriever
    (and a reader) would still have to work with. The chunk is returned
    alongside so the ranking can be asked whether it surfaced it: a split
    answer scores zero without the ranking being consulted at all, which
    is a fact about the metric rather than about retrieval.
    """
    answer_start = doc_texts[query.doc_id].index(query.answer)
    answer_end = answer_start + len(query.answer)
    best_id, best = None, 0.0
    for chunk in chunks:
        if chunk.doc_id != query.doc_id:
            continue
        overlap = min(chunk.end, answer_end) - max(chunk.start, answer_start)
        if overlap > 0 and overlap / len(query.answer) > best:
            best_id, best = chunk.id, overlap / len(query.answer)
    return best_id, best
