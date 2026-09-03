"""The `noise` mutation is invisible after normalization, so a pair whose
one side is a noise mutant is not a two-mutation pair.

`case_and_whitespace_noise` swaps case and doubles spaces; `normalize`
casefolds and collapses whitespace. On this corpus the two cancel exactly,
so `X--noise` and `X` have the same shingle set and every measurement of
`X--noise vs X--typo` is literally the measurement of `X vs X--typo`.
Reporting those 96 pairs inside a category labelled as compounding two
mutations dilutes it with 96 restatements of the single-mutation rows
printed directly above it.
"""

from pathlib import Path

import main as entry
from neardup.corpus import build_corpus, load_base_docs, true_duplicate_pairs
from neardup.shingles import jaccard, word_shingles

DATA_PATH = Path(__file__).parent.parent / "data" / "docs.jsonl"

COMPOUNDED = "mutant-mutant"
NOISE_PAIR = "noise+mutant"


def build():
    docs = build_corpus(load_base_docs(DATA_PATH), seed=entry.CORPUS_SEED)
    return docs, {d.doc_id: d for d in docs}, true_duplicate_pairs(docs)


def normalized(out: str) -> str:
    return " ".join(out.split())


class TestNoiseIsANormalizationNoOp:
    """The premise the split rests on, measured rather than assumed."""

    def test_every_noise_mutant_shingles_identically_to_its_base(self):
        docs, _, _ = build()
        shingles = {d.doc_id: word_shingles(d.text) for d in docs}
        noise = [d for d in docs if d.kind == "noise"]
        assert len(noise) == 24
        for d in noise:
            assert shingles[d.doc_id] == shingles[d.group], d.doc_id

    def test_the_noise_text_itself_is_not_identical(self):
        # the mutation does change the bytes - it is normalization that
        # erases it, which is the whole point of the category being wrong.
        docs, _, _ = build()
        by_id = {d.doc_id: d for d in docs}
        changed = [d for d in docs if d.kind == "noise" and d.text != by_id[d.group].text]
        assert len(changed) == 24

    def test_a_noise_pair_scores_exactly_as_the_base_pair_it_restates(self):
        docs, by_id, truth = build()
        shingles = {d.doc_id: word_shingles(d.text) for d in docs}
        checked = 0
        for a, b in truth:
            ka, kb = by_id[a].kind, by_id[b].kind
            if "noise" not in (ka, kb) or "base" in (ka, kb):
                continue
            noise_side, other = (a, b) if ka == "noise" else (b, a)
            base = by_id[noise_side].group
            assert jaccard(shingles[noise_side], shingles[other]) == jaccard(
                shingles[base], shingles[other]
            ), (a, b)
            checked += 1
        assert checked == 96


class TestPairKindSeparatesThem:
    def test_a_noise_pair_is_not_filed_as_compounded(self):
        _, by_id, _ = build()
        pair = ("cache-01--noise", "cache-01--typo")
        assert entry.pair_kind(by_id, pair) == NOISE_PAIR

    def test_a_genuinely_compounded_pair_still_is(self):
        _, by_id, _ = build()
        assert entry.pair_kind(by_id, ("cache-01--drop", "cache-01--typo")) == COMPOUNDED

    def test_single_mutation_rows_are_untouched(self):
        _, by_id, _ = build()
        assert entry.pair_kind(by_id, ("cache-01", "cache-01--noise")) == "noise"
        assert entry.pair_kind(by_id, ("cache-01", "cache-01--typo")) == "typo"

    def test_the_two_categories_hold_144_and_96(self):
        _, by_id, truth = build()
        counts: dict[str, int] = {}
        for pair in truth:
            kind = entry.pair_kind(by_id, pair)
            counts[kind] = counts.get(kind, 0) + 1
        assert counts[COMPOUNDED] == 144
        assert counts[NOISE_PAIR] == 96
        assert counts[COMPOUNDED] + counts[NOISE_PAIR] == 240


class TestEntryPointReportsBoth:
    def test_recall_tables_carry_both_rows_with_their_denominators(self, capsys):
        entry.main()
        out = capsys.readouterr().out
        assert out.count(f"{COMPOUNDED}: 117/144 (0.812)") == 1
        assert out.count(f"{COMPOUNDED}: 124/144 (0.861)") == 1
        # the noise row is identical in both tables, which is the point:
        # those 96 pairs measure what the single-mutation rows measure
        assert out.count(f"{NOISE_PAIR}:  94/96  (0.979)") == 2
        # the diluted blends must not appear anywhere any more
        assert "211/240" not in out
        assert "218/240" not in out

    def test_separability_splits_the_mutant_pairs(self, capsys):
        entry.main()
        out = capsys.readouterr().out
        assert (
            "mutant vs mutant : mean 0.499  min 0.280  max 0.708   (144 pairs)" in out
        )
        assert (
            "noise vs mutant  : mean 0.695  min 0.462  max 0.939   (96 pairs, "
            "noise is a normalization no-op" in out
        )
        # 0.939 was the published mutant-vs-mutant max and is really the
        # base-vs-shuffle max, restated
        assert "base vs  shuffle: mean 0.899  min 0.815  max 0.939" in out

    def test_the_duplicate_floor_is_unchanged(self, capsys):
        entry.main()
        out = capsys.readouterr().out
        assert "lowest duplicate jaccard (0.280)" in out
        assert "never sees 31 of brute force's 360 pairs" in out


class TestReadmeMatchesTheSplit:
    def test_readme_quotes_the_compounded_recall_not_the_blend(self):
        text = normalized((Path(__file__).parent.parent / "README.md").read_text())
        assert "0.812" in text
        assert "mutant-vs-mutant pairs at 0.879" not in text

    def test_readme_says_why_the_noise_pairs_are_separate(self):
        text = normalized((Path(__file__).parent.parent / "README.md").read_text())
        assert "normalization no-op" in text
        assert "96" in text

    def test_readme_no_longer_calls_every_mutant_pair_two_mutations(self):
        text = normalized((Path(__file__).parent.parent / "README.md").read_text())
        assert "mutant vs mutant pairs compound two mutations, so they sit lowest" not in text
