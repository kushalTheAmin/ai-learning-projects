import bisect
import heapq
from dataclasses import dataclass

from .inverted import InvertedBM25Index
from .tokenizer import tokenize


@dataclass
class PrunedSearchStats:
    """Work done by one pruned search call, counted exactly.

    postings_scored: (term, doc) gains actually computed
    probes: bisect jumps into posting lists (cursor skips and lookups)
    docs_scored: docs whose score entered top-k consideration
    docs_abandoned: candidates dropped mid-scoring by the bound (maxscore)
    terms_matched: query terms present in the index vocabulary
    postings_available: the term-at-a-time bill, sum of matched dfs
    """

    postings_scored: int
    probes: int
    docs_scored: int
    docs_abandoned: int
    terms_matched: int
    postings_available: int


class _ReversedId:
    """Wraps a doc id so a min-heap treats the LARGEST id as smallest.

    The result ordering is (-score, doc_id): among equal scores the
    smaller id ranks higher, so the heap's worst entry is the lowest
    score with the largest id.
    """

    __slots__ = ("value",)

    def __init__(self, value: str):
        self.value = value

    def __lt__(self, other: "_ReversedId") -> bool:
        return other.value < self.value


class _TopK:
    """Running top-k under the exact (-score, doc_id) ordering.

    threshold() is the k-th best score once k results are held, else
    None. A candidate with score equal to the threshold can still enter
    on a smaller doc id, which is why callers prune only on a strictly
    smaller upper bound.
    """

    def __init__(self, k: int):
        self.k = k
        self._heap: list[tuple[float, _ReversedId]] = []

    def threshold(self) -> float | None:
        if len(self._heap) < self.k:
            return None
        return self._heap[0][0]

    def add(self, score: float, doc_id: str) -> None:
        if len(self._heap) < self.k:
            heapq.heappush(self._heap, (score, _ReversedId(doc_id)))
            return
        worst_score, worst_rev = self._heap[0]
        if score > worst_score or (score == worst_score and doc_id < worst_rev.value):
            heapq.heapreplace(self._heap, (score, _ReversedId(doc_id)))

    def results(self) -> list[tuple[str, float]]:
        return sorted(
            ((rev.value, score) for score, rev in self._heap),
            key=lambda item: (-item[1], item[0]),
        )


class _Cursor:
    __slots__ = ("order", "plist", "idf", "ub", "pos")

    def __init__(self, order: int, plist: list[tuple[int, int]], idf: float, ub: float):
        self.order = order  # position among matched terms, query order
        self.plist = plist
        self.idf = idf
        self.ub = ub
        self.pos = 0

    @property
    def doc(self) -> int:
        return self.plist[self.pos][0]

    def exhausted(self) -> bool:
        return self.pos >= len(self.plist)


class PrunedBM25Index(InvertedBM25Index):
    """Dynamic pruning over the inverted index: MaxScore and WAND.

    Both are document-at-a-time searches that use an exact per-term
    score upper bound to skip postings that cannot reach the current
    top-k, and both return results bit-identical to the flat scan:
    same scores (gains summed in query-term order), same (-score,
    doc_id) tie-break, pinned by exact float equality in the tests.
    Pruning is only ever on a strictly smaller bound because a doc
    that ties the k-th score can still enter on a smaller id.
    """

    def __init__(self, docs: dict[str, str], k1: float = 1.5, b: float = 0.75):
        super().__init__(docs, k1=k1, b=b)
        self.upper_bounds = {
            term: max(self._gain(self.idf[term], tf, i) for i, tf in plist)
            for term, plist in self.postings.items()
        }

    def _gain(self, idf: float, tf: int, doc_index: int) -> float:
        # the flat scan's expression verbatim, so floats match bit for bit
        k1 = self.k1
        return idf * tf * (k1 + 1) / (tf + k1 * self.length_norms[doc_index])

    def _matched(self, query: str) -> list[_Cursor]:
        cursors = []
        for term in dict.fromkeys(tokenize(query)):  # unique, order preserved
            plist = self.postings.get(term)
            if plist is not None:
                cursors.append(
                    _Cursor(len(cursors), plist, self.idf[term], self.upper_bounds[term])
                )
        return cursors

    def search_wand(self, query: str, top_k: int = 10) -> list[tuple[str, float]]:
        results, _ = self.search_wand_with_stats(query, top_k)
        return results

    def search_wand_with_stats(
        self, query: str, top_k: int = 10
    ) -> tuple[list[tuple[str, float]], PrunedSearchStats]:
        matched = self._matched(query)
        postings_scored = probes = docs_scored = 0
        available = sum(len(c.plist) for c in matched)
        top = _TopK(top_k)
        cursors = list(matched) if top_k > 0 else []
        while cursors:
            cursors.sort(key=lambda c: c.doc)
            threshold = top.threshold()
            if threshold is None:
                pivot_idx = 0
            else:
                acc = 0.0
                pivot_idx = -1
                for idx, cursor in enumerate(cursors):
                    acc += cursor.ub
                    if acc >= threshold:  # a tie can still enter on doc id
                        pivot_idx = idx
                        break
                if pivot_idx < 0:
                    break  # no remaining doc can reach the top-k
            pivot_doc = cursors[pivot_idx].doc
            if cursors[0].doc == pivot_doc:
                at_pivot = [c for c in cursors if c.doc == pivot_doc]
                at_pivot.sort(key=lambda c: c.order)  # sum in query order
                score = 0.0
                for cursor in at_pivot:
                    score += self._gain(cursor.idf, cursor.plist[cursor.pos][1], pivot_doc)
                    postings_scored += 1
                top.add(score, self.doc_ids[pivot_doc])
                docs_scored += 1
                for cursor in at_pivot:
                    cursor.pos += 1
                cursors = [c for c in cursors if not c.exhausted()]
            else:
                cursor = cursors[0]
                cursor.pos = bisect.bisect_left(cursor.plist, (pivot_doc,), cursor.pos)
                probes += 1
                if cursor.exhausted():
                    cursors.pop(0)
        stats = PrunedSearchStats(
            postings_scored=postings_scored,
            probes=probes,
            docs_scored=docs_scored,
            docs_abandoned=0,
            terms_matched=len(matched),
            postings_available=available,
        )
        return top.results(), stats

    def search_maxscore(self, query: str, top_k: int = 10) -> list[tuple[str, float]]:
        results, _ = self.search_maxscore_with_stats(query, top_k)
        return results

    def search_maxscore_with_stats(
        self, query: str, top_k: int = 10
    ) -> tuple[list[tuple[str, float]], PrunedSearchStats]:
        matched = self._matched(query)
        postings_scored = probes = docs_scored = docs_abandoned = 0
        available = sum(len(c.plist) for c in matched)
        top = _TopK(top_k)
        if top_k <= 0 or not matched:
            return [], PrunedSearchStats(0, 0, 0, 0, len(matched), available)
        # suffix upper-bound sums in query order, for mid-doc abandonment
        suffix = [0.0] * (len(matched) + 1)
        for j in reversed(range(len(matched))):
            suffix[j] = suffix[j + 1] + matched[j].ub
        by_ub = sorted(matched, key=lambda c: (c.ub, c.order))

        def essential_start() -> int:
            # longest prefix of by_ub whose bounds sum strictly under the
            # threshold is non-essential: docs found only there cannot
            # enter, even on a tie
            threshold = top.threshold()
            if threshold is None:
                return 0
            acc = 0.0
            for idx, cursor in enumerate(by_ub):
                if acc + cursor.ub < threshold:
                    acc += cursor.ub
                else:
                    return idx
            return len(by_ub)

        while True:
            start = essential_start()
            if start == len(by_ub):
                break  # every term is non-essential, nothing can enter
            essential = set()
            candidate = -1
            for cursor in by_ub[start:]:
                if not cursor.exhausted():
                    essential.add(cursor.order)
                    if candidate < 0 or cursor.doc < candidate:
                        candidate = cursor.doc
            if candidate < 0:
                break  # essential lists exhausted
            threshold = top.threshold()
            score = 0.0
            abandoned = False
            for j, cursor in enumerate(matched):  # query order, flat-scan floats
                tf = 0
                if cursor.order in essential:
                    if not cursor.exhausted() and cursor.doc == candidate:
                        tf = cursor.plist[cursor.pos][1]
                else:
                    idx = bisect.bisect_left(cursor.plist, (candidate,))
                    probes += 1
                    if idx < len(cursor.plist) and cursor.plist[idx][0] == candidate:
                        tf = cursor.plist[idx][1]
                if tf:
                    score += self._gain(cursor.idf, tf, candidate)
                    postings_scored += 1
                if threshold is not None and score + suffix[j + 1] < threshold:
                    abandoned = True
                    break
            if abandoned:
                docs_abandoned += 1
            else:
                top.add(score, self.doc_ids[candidate])
                docs_scored += 1
            for cursor in by_ub[start:]:
                if not cursor.exhausted() and cursor.doc == candidate:
                    cursor.pos += 1
        stats = PrunedSearchStats(
            postings_scored=postings_scored,
            probes=probes,
            docs_scored=docs_scored,
            docs_abandoned=docs_abandoned,
            terms_matched=len(matched),
            postings_available=available,
        )
        return top.results(), stats
