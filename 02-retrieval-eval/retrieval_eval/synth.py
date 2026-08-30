import bisect
import itertools
import random

# Vocabulary terms are synthetic strings "t1".."t20000" whose draw
# probability follows a zipf law over rank, the shape real word
# frequencies have: a handful of stopword-like terms appear in nearly
# every doc, a long tail appears in almost none.
VOCAB_SIZE = 20_000
ZIPF_EXPONENT = 1.1
DOC_LENGTH_RANGE = (30, 90)
QUERY_TERM_COUNT = 4
COMMON_RANK_CUTOFF = 20
RARE_RANK_FLOOR = 1_000


class ZipfSampler:
    """Draws vocabulary ranks 1..vocab_size with P(rank) ~ 1/rank^s."""

    def __init__(self, vocab_size: int = VOCAB_SIZE, exponent: float = ZIPF_EXPONENT):
        if vocab_size < 1:
            raise ValueError(f"vocab_size must be positive, got {vocab_size}")
        weights = (1 / rank**exponent for rank in range(1, vocab_size + 1))
        self.cumulative = list(itertools.accumulate(weights))
        self.total = self.cumulative[-1]

    def draw(self, rng: random.Random) -> int:
        return bisect.bisect_left(self.cumulative, rng.random() * self.total) + 1


def term(rank: int) -> str:
    return f"t{rank}"


def generate_corpus(
    n_docs: int, seed: int, sampler: ZipfSampler | None = None
) -> dict[str, str]:
    """Seeded corpus of space-joined zipf-drawn terms, ids d00000.."""
    if n_docs < 0:
        raise ValueError(f"n_docs must be non-negative, got {n_docs}")
    sampler = sampler or ZipfSampler()
    rng = random.Random(seed)
    docs: dict[str, str] = {}
    for i in range(n_docs):
        length = rng.randint(*DOC_LENGTH_RANGE)
        docs[f"d{i:05d}"] = " ".join(term(sampler.draw(rng)) for _ in range(length))
    return docs


def generate_queries(
    n_queries: int,
    seed: int,
    stratum: str = "typical",
    sampler: ZipfSampler | None = None,
) -> list[str]:
    """Seeded query strings of QUERY_TERM_COUNT distinct terms each.

    typical      — terms drawn from the zipf law itself, the mix real
                   traffic has (usually one common term plus rarer ones)
    common-heavy — every term from the top COMMON_RANK_CUTOFF ranks
    rare-only    — every term from ranks >= RARE_RANK_FLOOR, uniform
    """
    if n_queries < 0:
        raise ValueError(f"n_queries must be non-negative, got {n_queries}")
    sampler = sampler or ZipfSampler()
    vocab_size = len(sampler.cumulative)
    rng = random.Random(seed)
    queries = []
    for _ in range(n_queries):
        ranks: dict[int, None] = {}
        while len(ranks) < QUERY_TERM_COUNT:
            if stratum == "typical":
                rank = sampler.draw(rng)
            elif stratum == "common-heavy":
                rank = rng.randint(1, COMMON_RANK_CUTOFF)
            elif stratum == "rare-only":
                rank = rng.randint(RARE_RANK_FLOOR, vocab_size)
            else:
                raise ValueError(f"unknown stratum: {stratum!r}")
            ranks[rank] = None
        queries.append(" ".join(term(rank) for rank in ranks))
    return queries
