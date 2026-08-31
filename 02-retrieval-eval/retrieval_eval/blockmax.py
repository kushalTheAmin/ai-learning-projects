import bisect
from dataclasses import dataclass

from .pruned import PrunedBM25Index, PrunedSearchStats, _TopK
from .tokenizer import tokenize

DEFAULT_BLOCK_SIZE = 64


@dataclass
class BlockMaxSearchStats(PrunedSearchStats):
    """PrunedSearchStats plus the block-max bookkeeping.

    shallow_checks: block-directory lookups (one per pivot-set cursor
        per shallow test, a bisect into the block metadata, no postings
        read)
    shallow_skips: pivots rejected by the block bound and jumped over
        without deep scoring
    """

    shallow_checks: int
    shallow_skips: int


class _BlockCursor:
    __slots__ = ("order", "plist", "idf", "ub", "block_last", "block_max", "pos")

    def __init__(
        self,
        order: int,
        plist: list[tuple[int, int]],
        idf: float,
        ub: float,
        block_last: list[int],
        block_max: list[float],
    ):
        self.order = order  # position among matched terms, query order
        self.plist = plist
        self.idf = idf
        self.ub = ub
        self.block_last = block_last
        self.block_max = block_max
        self.pos = 0

    @property
    def doc(self) -> int:
        return self.plist[self.pos][0]

    def exhausted(self) -> bool:
        return self.pos >= len(self.plist)


class BlockMaxBM25Index(PrunedBM25Index):
    """Block-Max WAND over the unchanged inverted index.

    A whole-list upper bound is set by the term's single best posting,
    so a common term's bound stays high across its entire list. Here
    each posting list is also cut into fixed-size blocks and the exact
    max gain per block is stored beside the last doc index the block
    covers. WAND's pivot selection still runs on the whole-list bounds;
    before a pivot is deep-scored, the sum of the pivot-set terms'
    current block maxes is checked against the threshold, and when even
    that local bound cannot reach it the cursors jump past the covered
    doc range without reading a posting.

    Results stay bit-identical to the flat scan: block maxes are exact
    maxima of the same gain expression, scores are still summed in
    query-term order, and a skip needs a strictly smaller bound because
    a doc that ties the k-th score can still enter on a smaller id.
    """

    def __init__(
        self,
        docs: dict[str, str],
        k1: float = 1.5,
        b: float = 0.75,
        block_size: int = DEFAULT_BLOCK_SIZE,
    ):
        super().__init__(docs, k1=k1, b=b)
        self.rebuild_blocks(block_size)

    def rebuild_blocks(self, block_size: int) -> None:
        """Recut the block directory at a new granularity, index unchanged."""
        if block_size < 1:
            raise ValueError(f"block_size must be positive, got {block_size}")
        self.block_size = block_size
        self.block_last: dict[str, list[int]] = {}
        self.block_max: dict[str, list[float]] = {}
        for term, plist in self.postings.items():
            idf = self.idf[term]
            lasts: list[int] = []
            maxes: list[float] = []
            for start in range(0, len(plist), block_size):
                block = plist[start : start + block_size]
                lasts.append(block[-1][0])
                maxes.append(max(self._gain(idf, tf, i) for i, tf in block))
            self.block_last[term] = lasts
            self.block_max[term] = maxes

    def block_count(self) -> int:
        """Directory entries stored, one (last doc, max gain) pair per block."""
        return sum(len(lasts) for lasts in self.block_last.values())

    def _matched_blocks(self, query: str) -> list[_BlockCursor]:
        cursors = []
        for term in dict.fromkeys(tokenize(query)):  # unique, order preserved
            plist = self.postings.get(term)
            if plist is not None:
                cursors.append(
                    _BlockCursor(
                        len(cursors),
                        plist,
                        self.idf[term],
                        self.upper_bounds[term],
                        self.block_last[term],
                        self.block_max[term],
                    )
                )
        return cursors

    def search_block_max_wand(
        self, query: str, top_k: int = 10
    ) -> list[tuple[str, float]]:
        results, _ = self.search_block_max_wand_with_stats(query, top_k)
        return results

    def search_block_max_wand_with_stats(
        self, query: str, top_k: int = 10
    ) -> tuple[list[tuple[str, float]], BlockMaxSearchStats]:
        matched = self._matched_blocks(query)
        postings_scored = probes = docs_scored = 0
        shallow_checks = shallow_skips = 0
        available = sum(len(c.plist) for c in matched)
        top = _TopK(top_k)
        cursors = list(matched) if top_k > 0 else []
        block_size = self.block_size
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
            # widen the pivot set across cursors already sitting on the
            # pivot doc, so a shallow skip's jump target is strictly past it
            last = pivot_idx
            while last + 1 < len(cursors) and cursors[last + 1].doc == pivot_doc:
                last += 1
            if threshold is not None:
                # shallow test: docs in [pivot_doc, boundary] can only hold
                # terms from cursors[:last + 1], and within each term's
                # current block the exact block max caps its gain. the
                # pivot cursor sits on pivot_doc, so its block covers it
                # and boundary is always set.
                block_sum = 0.0
                boundary = -1
                for cursor in cursors[: last + 1]:
                    lo = cursor.pos // block_size
                    bidx = bisect.bisect_left(cursor.block_last, pivot_doc, lo)
                    shallow_checks += 1
                    if bidx < len(cursor.block_last):
                        block_sum += cursor.block_max[bidx]
                        block_end = cursor.block_last[bidx]
                        boundary = block_end if boundary < 0 else min(boundary, block_end)
                if block_sum < threshold:
                    shallow_skips += 1
                    target = boundary + 1
                    if last + 1 < len(cursors):
                        target = min(target, cursors[last + 1].doc)
                    for cursor in cursors[: last + 1]:
                        if cursor.doc < target:
                            cursor.pos = bisect.bisect_left(
                                cursor.plist, (target,), cursor.pos
                            )
                            probes += 1
                    cursors = [c for c in cursors if not c.exhausted()]
                    continue
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
        stats = BlockMaxSearchStats(
            postings_scored=postings_scored,
            probes=probes,
            docs_scored=docs_scored,
            docs_abandoned=0,
            terms_matched=len(matched),
            postings_available=available,
            shallow_checks=shallow_checks,
            shallow_skips=shallow_skips,
        )
        return top.results(), stats
