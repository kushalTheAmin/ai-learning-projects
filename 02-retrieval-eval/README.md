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

## tradeoffs and limits

- the corpus is 40 docs and scoring loops over all of them per query term — fine here, wrong at scale. real systems use an inverted index to only touch docs containing the query terms, and this implementation is structured so that swap would be localized
- no stemming or stopword removal — thats deliberate, it keeps the failure modes visible ("password" vs "passwords" failing is the lesson, stemming would hide it and also bring its own errors)
- the golden labels are mine and the dataset is small — the bootstrap section is what "small" costs, measured: the headline bm25 vs tf-idf gap cant be told apart from noise at n=38. real retrieval evals want hundreds of queries and graded relevance, not binary
- a percentile bootstrap at n=38 is the honest-but-rough tool — coverage isnt guaranteed this small, and reciprocal rank is lumpy (1, 0.5, 0.333... or 0), so the resampled means are discrete too. bca intervals would be the upgrade if a decision actually hung on the third decimal
- ties in head to head are common because most queries here are easy for both systems — the interesting signal is concentrated in the disagreements, which is generally true of retrieval evals on any dataset

## open questions

- how many queries would it take before the bm25 vs tf-idf interval excludes zero, assuming the effect is real? the per-query win rate is measurable, so a power analysis could answer this with simulation instead of hand-waving
- 03s alpha sweep picked 0.2 over 0.5 on 40 queries and called it tea leaves — this exact machinery would say whether any of those alpha differences are distinguishable at all
- significance is not importance: with enough queries a +0.001 mrr gap becomes "real" — what mrr delta actually changes anything a user sees? that number has to come from the product, not the bootstrap
