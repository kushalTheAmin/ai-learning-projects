"""The retrieval systems under comparison.

single_shot: one BM25 search with the raw question. The baseline every
multi-hop scheme has to beat, and the cheapest thing that could work.

iterative: search with the question, extract bridge terms from the top
doc (bridge.py), search again with a rewritten query, then round-robin
merge the two rankings. Two modes for the rewrite:
  append: hop-2 query is the question plus the bridge terms. Keeps the
          attribute words ("which team", "what region") that pick the
          right fact out of the bridge entity's docs.
  focus:  hop-2 query is the bridge terms alone. Maximum pull toward the
          bridge entity, at the cost of every other word the question said.

oracle bridge: iterative with the gold bridge substituted for the
extractor's output. The gap between oracle and extracted is the price of
scripted extraction; the gap between oracle and perfect is hop-2 ranking
failure that no extractor can fix.
"""

from dataclasses import dataclass, field

from .bridge import extract_bridge_terms
from .reuse import BM25Index


@dataclass(frozen=True)
class Retrieval:
    ranking: list[str]  # what a downstream reader would consume
    hop1_ranking: list[str]
    hop2_ranking: list[str] = field(default_factory=list)
    bridge_terms: list[str] = field(default_factory=list)
    search_calls: int = 1


def interleave(first: list[str], second: list[str]) -> list[str]:
    """Round-robin merge, first list leading, later duplicates dropped."""
    merged: list[str] = []
    seen: set[str] = set()
    for i in range(max(len(first), len(second))):
        for source in (first, second):
            if i < len(source) and source[i] not in seen:
                seen.add(source[i])
                merged.append(source[i])
    return merged


def single_shot(index: BM25Index, question: str, top_k: int = 10) -> Retrieval:
    ranking = [doc_id for doc_id, _ in index.search(question, top_k=top_k)]
    return Retrieval(ranking=ranking, hop1_ranking=ranking)


def iterative(
    index: BM25Index,
    docs: dict[str, str],
    question: str,
    top_k: int = 10,
    mode: str = "append",
    bridge_override: list[str] | None = None,
    max_terms: int = 3,
) -> Retrieval:
    if mode not in ("append", "focus"):
        raise ValueError(f"mode must be 'append' or 'focus', got {mode!r}")
    hop1 = [doc_id for doc_id, _ in index.search(question, top_k=top_k)]
    if bridge_override is not None:
        bridge = list(bridge_override)
    elif hop1:
        bridge = extract_bridge_terms(docs[hop1[0]], question, index, max_terms)
    else:
        bridge = []
    if not bridge:
        # nothing to hop on: fall back to the single search already made
        return Retrieval(ranking=hop1, hop1_ranking=hop1)
    joined = " ".join(bridge)
    hop2_query = f"{question} {joined}" if mode == "append" else joined
    hop2 = [doc_id for doc_id, _ in index.search(hop2_query, top_k=top_k)]
    return Retrieval(
        ranking=interleave(hop1, hop2),
        hop1_ranking=hop1,
        hop2_ranking=hop2,
        bridge_terms=bridge,
        search_calls=2,
    )
