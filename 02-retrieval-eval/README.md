# retrieval eval: bm25 vs tf-idf, measured

two lexical retrieval algorithms implemented from scratch in pure python — okapi bm25 and tf-idf cosine — benchmarked head to head on a committed golden dataset with recall@k and mrr. no api keys, no downloads, fully offline and deterministic

## the concept

before you reach for embeddings and a vector database, this is the baseline you should be able to build and beat. both systems score documents by word overlap with the query, the interesting part is *how* they weigh it

**tf-idf cosine** — each doc becomes a vector of term weights, term frequency times inverse document frequency, l2 normalized. score is the cosine between query vector and doc vector. same weighting sklearn uses by default

**bm25** — the ranking function behind lucene and elasticsearch. two fixes over raw tf-idf that matter in practice

- term frequency saturates. the tenth occurrence of "cache" in a doc is worth almost nothing, so a doc that stuffs a term cant dominate. controlled by k1
- document length is explicitly normalized against the corpus average, so long kitchen-sink docs that mention everything dont win on volume alone. controlled by b, and the benchmark includes b=0 as an ablation so you can see what that knob is actually buying

the eval side is the part interviews actually probe — retrieval quality is measured, not vibed. **recall@k**: fraction of the labeled relevant docs that show up in the top k. **mrr**: 1/rank of the first relevant hit, averaged over queries — rewards putting the answer at position 1, not just somewhere in the list

## whats in here

- `retrieval_eval/bm25.py`, `retrieval_eval/tfidf.py` — the two scorers, from scratch, no numpy
- `retrieval_eval/metrics.py` — recall@k and reciprocal rank
- `retrieval_eval/evaluate.py` — runs a system over the query set, aggregates, and does per-query head to head
- `retrieval_eval/bootstrap.py` — paired bootstrap resampling: confidence intervals on mrr and on the gap between systems
- `retrieval_eval/inverted.py` — the same bm25 served from an inverted index, pinned bit-identical to the flat scan
- `retrieval_eval/pruned.py`: maxscore and wand dynamic pruning over that index, exact top-k for a fraction of the postings
- `retrieval_eval/synth.py` — seeded synthetic corpora with zipf term frequencies, for the scaling study
- `scaling.py` — full scan vs inverted index, measured: wall clock, docs scanned, postings touched
- `pruning.py`: how much of the postings bill the score bounds skip, per stratum and per k
- `data/corpus.jsonl` — 40 short docs on dev topics (git, docker, python, http, sql, shell), including two deliberately long kitchen-sink docs that exist to trip up naive scoring
- `data/queries.jsonl` — 38 queries, each labeled with its relevant doc ids. some use exact doc vocabulary, some paraphrase, and a few share almost no words with their answer on purpose

## run it

```
cd 02-retrieval-eval
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m pytest
python main.py
python scaling.py
python pruning.py
```

python 3.11+. the only dependency is pytest — the retrieval code itself is stdlib

## the numbers

```
system                  recall@1     recall@5     mrr@10
--------------------------------------------------------
tf-idf cosine           0.868        0.947        0.917
bm25 (k1=1.5, b=0.75)   0.895        0.947        0.934
bm25 (b=0, no len norm) 0.816        0.947        0.893
```

what theyre saying

- bm25 edges out tf-idf on recall@1 and mrr — when they disagree its because tf-idf let a long doc with lots of term repetition outrank the precise answer. `main.py` prints the actual disagreeing queries with both top-3 lists so you can see it, the clearest one is "expire old entries from an in-memory cache" where tf-idf puts the kitchen-sink caching doc first and bm25 puts the redis doc first
- turning off length normalization (b=0) makes bm25 *worse than tf-idf* at recall@1 — tf-idf gets a weak length correction for free from l2 normalization, bm25 with b=0 has none. length normalization is doing real work
- recall@5 ties between bm25 and tf-idf because they miss the exact same two queries entirely — see below

## is the gap real

0.934 vs 0.917 looks like a win, but its a mean over 38 queries — so the benchmark bootstraps it. resample the query set with replacement 10000 times, recompute mrr on each resample, read the spread as the uncertainty of the measurement. for system-vs-system the resampling is paired — the per-query differences get resampled, so the coupling between systems (both acing the same easy queries, both missing the same hard ones) stays in instead of getting averaged away

`main.py` prints:

```
is the gap real? paired bootstrap over queries (10000 resamples, 95% ci)
  tf-idf cosine             mrr 0.917  [0.825, 0.987]
  bm25 (k1=1.5, b=0.75)     mrr 0.934  [0.855, 1.000]
  bm25 (b=0, no len norm)   mrr 0.893  [0.803, 0.969]

  mrr difference, paired per query:
  bm25 vs tf-idf cosine   +0.018  [+0.000, +0.048]  <=0 in 12.7% of resamples — interval includes zero
  bm25 vs bm25 b=0        +0.041  [+0.001, +0.091]  <=0 in 2.1% of resamples — interval excludes zero
```

how to read it

- each systems 95% interval is about 0.15 wide. the third decimal in the metrics table was never meaningful, and even the second is shaky — this is what "38 queries is small" looks like as a number
- **bm25 vs tf-idf: the headline gap doesnt clear the bar.** the interval bottoms out at exactly zero and the gap vanishes in 12.7% of resamples. the head to head says why — bm25 wins 2 queries, loses 0, ties 36. bm25 literally never loses to tf-idf on this set, but the entire gap hangs on 2 of 38 queries, and a resample that misses both of them ties the systems exactly. "never loses, but the evidence is thin" is the honest verdict, and neither the raw 0.017 gap nor a single p-value would have told you that
- **bm25 vs b=0: the ablation gap survives.** [+0.001, +0.091], on the wrong side of zero in only 2.1% of resamples. the length-normalization effect is bigger and spread across more queries, so it stays distinguishable from noise even at n=38 — an interval can exclude zero on a small dataset if the effect shows up broadly instead of resting on two lucky queries
- `p_le_zero` counts resamples where the gap comes out <= 0. its a direction-stability check, not a hypothesis-test p-value — the readme says which because confusing the two is how retrieval blog posts end up claiming significance they dont have

## where lexical search breaks

two queries score zero for both bm25 and tf-idf — "log in to a server without typing a password" (answer: the ssh keys doc) and "why does my site suddenly show old content after a deploy" (answer: caching). the words just dont overlap — "log in" vs "login", "password" vs "passwords", "old content" vs "stale cache entries". no amount of tf weighting fixes vocabulary mismatch, the term either matches or it doesnt

thats the honest pitch for dense retrieval — embeddings exist to close exactly that gap. and its also why hybrid search is the default answer in production: bm25 wins on exact identifiers, error codes and rare terms, dense wins on paraphrase

## at scale: the inverted index, measured

the tradeoffs section below used to wave at this: scoring loops over every doc per query term, fine at 40 docs, wrong at scale. `scaling.py` does the swap and measures what it buys. `retrieval_eval/inverted.py` is the same okapi bm25 served from posting lists, term -> [(doc, tf)], so a query only touches docs that contain its own terms. `retrieval_eval/synth.py` generates the corpora: seeded synthetic docs whose term frequencies follow a zipf law, the shape real text has, a handful of stopword-like terms in nearly every doc and a long tail in almost none

what is simulated here: the scaling corpora are synthetic terms (`t1`..`t20000`) drawn zipf, and the queries are generated term samples, not english. these numbers price the two data structures under a realistic document-frequency shape and say nothing new about retrieval quality. quality stays the original benchmarks job, on the unchanged golden dataset. wall-clock numbers are one run of `python scaling.py` on one machine, so expect them to wobble a little run to run; the work counts (docs scanned, postings touched, candidates, df) are seeded and exactly reproducible

the contract comes first. not approximately the same ranking, the same floats:

```
== same math, pinned ==
golden corpus, full-depth rankings identical: 38/38 queries
synthetic 2000-doc corpus, top-10 identical: 150/150 queries (all strata)
```

the inverted scorer accumulates term-at-a-time in the same order the flat scan would, so every score comes out bit-identical, and the tests assert result-list equality on exact floats. an optimization that changes results isnt an optimization, its a different system

then the sweep, the same 200 zipf-drawn queries replayed against growing corpora:

```
== corpus-size sweep, 200 typical queries per size ==
   docs  build flat  build inv  flat ms/q     p95  inv ms/q     p95  speedup  scanned/q  postings/q  touch ratio
----------------------------------------------------------------------------------------------------------------
   1000       0.03s      0.03s      0.910   1.201     0.321   0.492     2.8x       3640        1398         2.6x
   2000       0.06s      0.07s      2.342   2.934     0.619   0.947     3.8x       7550        2800         2.7x
   4000       0.11s      0.14s      5.437   6.727     1.278   1.972     4.3x      15620        5613         2.8x
   8000       0.22s      0.27s     11.890  14.795     2.596   3.983     4.6x      31800       11239         2.8x
  16000       0.53s      0.56s     26.352  32.300     5.845   9.065     4.5x      63840       22457         2.8x
  32000       1.49s      0.98s     65.229  82.640    11.487  17.522     5.7x     128000       44926         2.8x

both columns grow linearly in corpus size, so at 1,000,000 docs the measured slope projects to ~2.0s/query flat vs ~0.36s/query inverted

== what zipf traffic looks like at 32,000 docs ==
realized vocabulary 19,985 terms, 1,350,045 postings total
df of rank-1 term: 31,972 docs (99.9% of corpus)
df of rank-20 term: 8,744 docs (27.3% of corpus)
df of rank-1000 term: 135 docs (0.4% of corpus)

== query cost strata at 32,000 docs, 100 queries each ==
stratum         postings/q  candidates/q  flat ms/q  inv ms/q  speedup
----------------------------------------------------------------------
typical              46950         26963     63.398    11.647     5.4x
common-heavy         68765         30190     70.654    16.125     4.4x
rare-only               77            77     32.924     0.086   382.6x

on typical queries the single most common term owns 64.9% of all postings touched, mean over queries
```

what the numbers say

- **the flat scan falls over on schedule, and smoothly.** per-query latency is linear in corpus size, 0.910ms at 1k docs to 65.229ms at 32k, so theres no cliff to point at, just a line that crosses whatever latency budget you have somewhere in the tens of thousands of docs and keeps going. by 1M docs its ~2.0s per query
- **the inverted index is not a complexity-class win on zipf traffic.** postings touched grow linearly with corpus size too (1398 per query at 1k docs, 44926 at 32k), because document frequency grows with the corpus. the touch ratio sits flat at 2.8x across the sweep and the wall-clock speedup hovers in the 3-6x band instead of widening with size (it runs a bit above the touch ratio because the flat scan also sorts all n scores per query where the inverted index heap-selects from the candidates). the class win people imagine is real only for rare terms
- **why the ceiling: zipf.** a typical 4-term query almost always carries at least one common term, and that terms posting list is most of the corpus. at 32k docs a typical query still scores 26963 candidate docs of 32000, and the single most common term in a query owns 64.9% of the postings it touches. the inverted index does exactly what it promises, it skips docs holding none of the query terms; zipf makes sure there are few of those
- **rare terms live in the other world.** rare-only queries touch 77 postings where the flat scan still reads the full 32000-doc corpus once per matched term, 0.086ms against 32.924ms, 382.6x, and that cost is essentially flat in corpus size. the cost of an inverted-index query is the sum of its terms document frequencies, not the size of the corpus, which is why specific queries feel instant in real engines
- **the flat scan pays full price even when nothing matches.** 32.924ms on rare-only queries, same order of magnitude as common-heavy, because it scans and sorts every doc regardless. the inverted index gets its 382.6x precisely there
- **so production is posting lists plus head-term handling.** stopword removal, idf-ordered term processing, early-termination schemes like wand and max-score exist because posting lists alone dont beat zipf, they just stop paying for the tail

one number worth being honest about: the postings hold the same (doc, tf) pairs the flat index keeps in per-doc counters, just re-keyed by term. this is an access-pattern change, not a compression story, and the memory line (1,350,045 postings at 32k docs) is the same information either way

## dynamic pruning: skipping postings without changing the answer

the section above ends on "posting lists alone dont beat zipf": the inverted index still scores every posting of every query term, and on common-heavy traffic thats 68765 postings per query. wand and maxscore are the classic fixes. both precompute, per term, the largest score that term can contribute to any document (exact, not estimated: the max of the bm25 gain over the terms own postings). while searching, the k-th best score so far is a threshold, and any document whose terms bounds cant reach that threshold is skipped without being scored. `retrieval_eval/pruned.py` implements both over the unchanged inverted index, and `pruning.py` measures them on the same 32k-doc zipf corpus and query strata as the scaling study

the two algorithms spend the bound differently. **maxscore** splits query terms into essential and non-essential: once the low-bound terms together cant lift a doc past the threshold, docs found only in their lists stop being candidates, and those lists are only probed by binary search to finish scoring docs the essential lists surfaced. **wand** keeps a cursor per term sorted by current doc id and finds a pivot, the first doc whose prefix of bounds reaches the threshold; everything before the pivot is jumped over entirely

same caveats as the scaling study: synthetic zipf terms, generated queries, one machine. the work counts are seeded and exactly reproducible, the wall clocks wobble run to run. and the same contract comes first, because pruning that changes results is just a worse ranking function:

```
== same top-k, pinned against the flat scan ==
golden corpus, top-10 identical: maxscore 38/38, wand 38/38 queries
golden corpus, full depth identical: maxscore 38/38, wand 38/38 queries
synthetic 2000-doc corpus, top-10 identical: maxscore 150/150, wand 150/150 queries (all strata)
```

exact float equality again, ties included. the tests force the case where every candidate ties the threshold exactly and the winner has to come from doc-id order, which is precisely where a sloppy `<=` in the pruning comparison silently drops the right answer

what the bounds look like on zipf postings:

```
== why common terms prune well at top-10 ==
rank-1 term: df 31,972, score upper bound 0.0021
rank-20 term: df 8,744, score upper bound 2.5039
rank-1000 term: df 135, score upper bound 7.0511
```

thats the whole trick in three lines. idf has already decided that the rank-1 term, present in 99.9% of docs, can contribute at most 0.0021 to any score, so the moment the top-10 threshold clears a tiny bar, its 31,972 postings stop being worth reading one by one. the postings a query is billed for and the postings that can change its answer are different lists

```
== postings scored per query at 32,000 docs, top-10, 100 queries each ==
stratum         taat post/q  maxscore  probes  % of bill    wand  probes  % of bill
-----------------------------------------------------------------------------------
typical               46950      4907    3614      10.5%    4928    4446      10.5%
common-heavy          68765     21794   20882      31.7%   20306   22994      29.5%
rare-only                77        68      20      88.7%      68       3      88.5%
```

- **the answer to the open question: at top-10, the bounds skip 68-70% of the common-heavy bill** (68765 postings term-at-a-time, 21794 scored by maxscore, 20306 by wand) **and just under 90% of the typical bill** (46950 down to ~4900). probes are the binary-search jumps that replace the reading. they land on one posting each, so even charging a probe as a touched posting the skip stays above 60% and 80%
- **rare-only queries have nothing to skip.** the bill is 77 postings, the bounds save nothing worth having (88.7% still scored), and the pruning bookkeeping is pure overhead. dynamic pruning is a head-term technology; the tail was already cheap
- **maxscore and wand land within a few percent of each other on postings scored.** the difference is where the work goes: on common-heavy, wand spends more probes (22994 vs 20882) because its cursors leapfrog per pivot, while maxscore reads its essential lists linearly and probes only the non-essential ones

the wall clock is the honest asterisk:

```
wall clock, ms per query (same runs)
stratum            taat  maxscore     wand
------------------------------------------
typical          27.249    12.848   21.420
common-heavy     40.477    57.185   93.004
rare-only         0.113     0.336    0.269
```

on typical queries maxscore converts its 10.5% postings bill into a real 2.1x wall-clock win. on common-heavy, both pruners are *slower* than the exhaustive scan they beat 3x on work counts. the reason is constant factors, not the algorithm: term-at-a-time is one dict lookup and one add per posting in a tight loop, while document-at-a-time pays python-level cursor sorting, attribute access, and bisect calls per candidate, and at 30% postings scored that overhead eats the saving. same lesson as the ann project (13): in pure python the operation count is the portable number and the wall clock is a property of the interpreter. a production engine gets the counts *and* the clock because its per-posting costs are branch-predictable native code, and it wouldnt sort cursors with a comparison sort per pivot either

where the bound stops paying:

```
== where the bound stops paying: k sweep, common-heavy, 32,000 docs ==
    k  taat post/q  maxscore  % of bill    ms/q    wand  % of bill    ms/q
--------------------------------------------------------------------------
    1        68765     17071      24.8%  45.836   16327      23.7%  84.508
   10        68765     21794      31.7%  54.775   20306      29.5%  91.479
  100        68765     28656      41.7%  69.340   26853      39.1%  97.112
 1000        68765     40818      59.4% 100.350   40528      58.9% 119.959
```

the threshold is the k-th best score seen so far, so bigger k means a weaker threshold for longer: at k=1 the pruners read a quarter of the bill, at k=1000 they read 60% of it and the gap is still closing. dynamic pruning is a top-k technology in the strictest sense: "give me everything relevant" gets no help, and anything that lowers the threshold (a heap that must fill before pruning starts, a rescoring stage that wants deep candidate pools) is paid for directly in postings read

## tradeoffs and limits

- the golden corpus is 40 docs and the original scorer loops over all of them per query term — fine here, wrong at scale, and now measured instead of asserted: the section above puts the flat scan at 65.229ms/query by 32k docs while the inverted twin returns the bit-identical ranking for a fraction of the work
- no stemming or stopword removal — thats deliberate, it keeps the failure modes visible ("password" vs "passwords" failing is the lesson, stemming would hide it and also bring its own errors)
- the golden labels are mine and the dataset is small — the bootstrap section is what "small" costs, measured: the headline bm25 vs tf-idf gap cant be told apart from noise at n=38. real retrieval evals want hundreds of queries and graded relevance, not binary
- a percentile bootstrap at n=38 is the honest-but-rough tool — coverage isnt guaranteed this small, and reciprocal rank is lumpy (1, 0.5, 0.333... or 0), so the resampled means are discrete too. bca intervals would be the upgrade if a decision actually hung on the third decimal
- ties in head to head are common because most queries here are easy for both systems — the interesting signal is concentrated in the disagreements, which is generally true of retrieval evals on any dataset

## open questions

- how many queries would it take before the bm25 vs tf-idf interval excludes zero, assuming the effect is real? the per-query win rate is measurable, so a power analysis could answer this with simulation instead of hand-waving
- 03s alpha sweep picked 0.2 over 0.5 on 40 queries and called it tea leaves — this exact machinery would say whether any of those alpha differences are distinguishable at all
- significance is not importance: with enough queries a +0.001 mrr gap becomes "real" — what mrr delta actually changes anything a user sees? that number has to come from the product, not the bootstrap
- the whole-list upper bound of a common term is set by its single best posting. block-max wand keeps a max per posting block instead, so the pivot can skip within a list, not just between lists. how much deeper does that cut the 30% common-heavy floor at top-10?
- the common-heavy wall-clock inversion is a constant-factor story: the same document-at-a-time counts in native code (or with block-encoded postings and vectorized scoring) should follow the counts; the crossover between "counts win" and "clock wins" is unmeasured here
- pruning only starts once the top-k heap fills; a warm-start threshold (from a cached previous run of the same query, or a cheap first-pass estimate) would prune from posting one. at k=10 the k=1 column bounds what that could buy (31.7% → 24.8%), and whether a stale threshold ever drops a right answer is the interesting failure mode
- the bounds here are exact because the index is static: every added doc can raise a terms bound and every deletion can strand it too high, so mutation either re-prices bounds per update or lets them go stale-but-sound; the cost of each choice is unmeasured (same shape as the rebuild-vs-patch question below)
- the posting lists here are python lists of tuples, so delta-encoded varint-compressed postings are the real memory story, and the decode cost per query is the tradeoff this study didnt price
- a typical query builds a score accumulator over 84% of the corpus, so per-query memory scales with df too; accumulator capping (keep only the best partial scores) trades recall for memory and the damage is measurable here
- adding one doc to the inverted index is an append per term, but it moves df and avg doc length, which silently re-prices every idf. at what update rate does rebuild-vs-patch flip, and is that why real engines ship immutable segments with background merges?
