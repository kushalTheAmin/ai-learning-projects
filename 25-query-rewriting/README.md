# 25-query-rewriting

query rewriting for lexical retrieval, measured against the raw query. no model runs here: the HyDE generation step is simulated by 40 authored hypothetical answers (one per query, written from the question text alone, never from the corpus documents), and a seeded hallucination knob swaps an answer for the authored answer to a different question, fluent and confidently wrong. so the headline numbers measure the retrieval mechanics of query rewriting at a controlled generator quality, an upper bound for what a knowledgeable model could buy, not what any particular model actually delivers. the corpus and golden queries are 03's committed dataset reused as data; bm25, metrics and the paired bootstrap are imported from 02, and the pseudo-relevance-feedback expander is 23's bridge-term extractor pointed at a one-hop query.

## the idea

lexical retrieval fails when the query and the answer document use different words. HyDE (hypothetical document embeddings) attacks that from the query side: ask a model to write a hypothetical answer, then search with that text, betting that a fluent answer shares vocabulary with the real answer doc even when the question does not. the bet has a dark side, and thats the thing this project measures: if the generator writes a confident answer about the wrong thing, you are now searching for the wrong thing fluently. pseudo-relevance feedback is the model-free cousin, append distinctive terms from the first search's top doc and search again.

## run it

```
pip install -r requirements.txt
python3 main.py
python3 -m pytest -q
```

runs offline, no api key, nothing downloads. python 3.11.

## what came out

all 40 queries, mrr@10 also split by query category:

```
system           recall@1  recall@5   mrr@10   mrr kw  mrr para  +terms
raw                 0.787     0.850    0.830    0.925     0.736     0.0
prf-5               0.787     0.850    0.838    0.925     0.751     4.9
hyde-append         0.963     1.000    0.983    1.000     0.967    23.3
hyde-replace        0.963     1.000    0.981    1.000     0.963    23.3
generic-append      0.400     0.762    0.560    0.700     0.420    32.1
```

paired bootstrap vs raw, per-query rr@10, 10000 resamples, 95% ci:

```
prf-5           diff +0.008 [+0.000, +0.020] p(diff <= 0) = 0.1289
hyde-append     diff +0.153 [+0.046, +0.270] p(diff <= 0) = 0.0018
hyde-replace    diff +0.151 [+0.042, +0.269] p(diff <= 0) = 0.0028
generic-append  diff -0.270 [-0.379, -0.164] p(diff <= 0) = 1.0000
```

three results worth stating plainly.

**a knowledgeable rewrite is worth a lot, and the value is concentrated exactly where retrieval fails.** raw bm25 scores 0.925 on keyword queries and 0.736 on paraphrase queries, the vocabulary-mismatch gap 03 first measured. honest hyde-append closes it, 0.967 on paraphrase, because the authored answer says "stash" when the query says "put my unfinished changes somewhere". the cleanest single case is k14: the query is "GIL", the corpus only ever spells the term out, raw search matches nothing at all, and the spelled-out hypothetical answer is the bridge to a perfect hit. that rescue is pinned by a test.

**fluent ignorance is not zero value, it is negative value.** generic-append adds a plausible best-practices filler answer to every query and drops mrr from 0.830 to 0.560, worse than doing nothing, with p(diff <= 0) = 1.0000. bm25 counts each distinct search term once, so the 32.1 added filler terms all vote for whatever docs happen to contain them. the lesson transfers: rewriting buys nothing unless the rewriter actually knows something about the answer.

**prf is nearly a no-op on this corpus.** +0.008 overall with the ci lower bound sitting on +0.000. the split by expansion source explains it: on 32 of 40 queries the first search's top doc was already a gold doc, and expanding from it changed mean rr by exactly +0.000, terms from a doc you already rank first cannot move it up. on the 7 queries where the top doc was wrong it gained +0.044, because the wrong doc was usually topic-adjacent (a git doc for a git question) and its distinctive terms still vote for the right neighborhood. and the one query prf could have rescued, k14, it structurally cannot: no first results means nothing to extract from. depth barely matters (mrr 0.834 at 1 term, 0.838 at 3, 5 and 10).

## the hallucination sweep

each query has a fixed wrong answer (the next query's authored answer, so its confidently on the wrong subject) and a seeded nested draw decides whether it fires, so sweeping the rate moves one variable. the draw is the rate-quantile of the per-query scores, not a coin per query, so n_halluc is exactly the rate — a coin gives it in expectation and 40 queries is not enough for that to be the same thing:

```
  rate  n_halluc  append mrr  replace mrr  append mrr (halluc only)
  0.00         0       0.983        0.981                        --
  0.10         4       0.919        0.897                     0.361
  0.25        10       0.818        0.747                     0.339
  0.50        20       0.652        0.509                     0.338
  1.00        40       0.367        0.057                     0.367
  (raw mrr@10 for reference: 0.830)
```

append and replace are near-identical when the generator is honest (0.983 vs 0.981) and pull apart the moment it isnt. at 10% both still clear the raw query — replace 0.897, append 0.919 — so a rewrite survives the occasional confident wrong answer. replace crosses under raw between 15% and 17.5%, append between 22.5% and 25%, and the gap between those two brackets is the whole value of keeping the original query in the search string. at full hallucination the anchor is everything: append keeps the original query terms voting and lands at 0.367, replace searches for the wrong answer alone and lands at 0.057. so "should i search with the query plus the rewrite, or the rewrite alone" is really a bet on your generator's error rate, and the append anchor buys another 5 to 10 points of that rate before the rewrite stops paying at all. 23 found the mirror image on hop-2 queries (focus beat append because question terms re-admitted distractors); the difference is that here the query names the right doc's topic, there hop 1's question named the wrong one.

honest hyde is not free of regressions either: p07 (request waits forever, server never answers) falls from rr 1.000 to 0.333 under hyde-append at rate 0, because a correct answer about timeouts votes for every doc that discusses timeouts, not just the gold one. the biggest-moves table in the output shows both tails.

## tradeoffs and where it breaks

- the 0.983 is an upper bound story. the authored answers play a generator that always knows the right subject; the sweep says what happens as that assumption decays, and 0.560 (generic) is the floor where it knows nothing.
- hallucination here is total, the answer to a different question entirely. a real model more often half-knows: right topic, wrong flag names. that failure adds mostly on-topic vocabulary and should sit between honest and swapped; this harness cannot say where.
- everything is one lexical index over 100 docs. hyde was proposed for dense retrieval, where the hypothetical becomes an embedding rather than a bag of terms; the anchor/dilution mechanics measured here are bm25's, not an embedder's.
- the rewrite cost is invisible in this table: +23.3 terms per search string is nothing, but real hyde pays a model generation per query at interactive latency, which is the actual price of the mrr it buys.

## language

python, because the entire stack it composes with lives there: 02's bm25 and bootstrap, 03's dataset, 23's extractor. the project adds no new numerics, so the language question was settled by the imports.

## open questions

- a real model writing hypotheticals for these same 40 queries: where between 0.983 (knowledgeable) and 0.560 (fluent ignorance) does it land, and what hallucination rate does it actually exhibit on questions this ordinary
- partial hallucination, right topic wrong details, should degrade append more gently than the total swap measured here; needs a graded wrongness knob, not a binary one
- append weights query and answer equally because bm25 counts each distinct term once; interpolating scores between a raw-query search and a hypothetical search (03's fusion machinery applies as is) might keep the anchor while shrinking honest-answer regressions like p07
- prf extracted from the top-1 doc only, and 32 of 40 top docs were already gold, leaving it nothing to do; whether multi-doc extraction or a worse first-pass retriever changes its value is unmeasured here
- real hyde samples several hypotheticals and averages; whether three authored paraphrases of the same answer beat one, or just widen the drift surface, is testable in this harness with more authoring

## fixes

- 2026-09-02 — the hallucination sweep drew an independent coin per query, so the column labelled `rate` was nominal and the row measured whatever 40 draws gave: 0.10 fired 7 (17.5%), 0.50 fired 15 (37.5%). the readme read its conclusion off the label — "one wrong answer in ten erases the entire benefit" — when at a real 10% replace scores 0.897, above raw's 0.830. the draw is now the rate-quantile of the same per-query scores, still nested, still seeded, and exactly round(rate * n) queries fire. rate 0.10 moved 0.866/0.822 → 0.919/0.897 and rate 0.50 moved 0.762/0.634 → 0.652/0.509; the crossing points are 15-17.5% for replace and 22.5-25% for append, not 10% and "somewhere between 10% and 25%". rate 0, 0.25 and 1.00 are unchanged and no other table moved.
