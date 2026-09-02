# 26-reranking

two-stage retrieval: a cheap first stage over the whole corpus, an expensive scorer over its shortlist, measured for what the second stage buys, what it costs, and when it makes things worse. no neural model runs here: the bi-encoder is 03's seeded LSA (the classical offline stand-in for an embedding model), the late-interaction reranker is MaxSim over per-term vectors read out of that same fitted LSA, and the cross-encoder slot is filled by an oracle that reads the relevance labels, which is the ceiling any scorer could reach on a given shortlist. so the numbers demonstrate the mechanics of the two-stage architecture, shortlist ceilings, cost scaling, scorer-vs-candidates interactions, not the quality any trained reranker would deliver. corpus, golden queries, retrievers, metrics and the paired bootstrap are all imported from 02 and 03; nothing is refit and no new dataset exists.

## the idea

a bi-encoder embeds query and document independently, so every document vector can be computed offline and query time is one dot product per candidate. a cross-encoder reads the pair together, nothing is precomputable, and cost scales with candidates times pair size. thats why production systems stack them: retrieve wide with the cheap one, rerank the top k with the expensive one. between the poles sits late interaction (colbert style): per-term vectors are precomputable like a bi-encoder, but scoring is a term-by-term max-similarity sum like a shrunken cross attention.

the two things this setup lets you measure cleanly:

- the shortlist is a hard ceiling. a reranked ranking here is the top k reordered with the rest of the first-stage ranking appended unchanged, exactly what a production two-stage retriever returns. a gold doc the first stage left below the cutoff keeps its first-stage rank no matter how good the scorer is, and the oracle rows price that ceiling exactly.
- cost has one currency. every scorer reports latent dot products actually spent: one per candidate for the pooled bi-encoder, |query terms| x |doc terms| per pair for MaxSim, zero for bm25 (its postings work is a different currency, reported as zero latent dots, not as free).

## run it

```
pip install -r requirements.txt
python3 main.py
python3 -m pytest -q
```

runs offline, no api key, nothing downloads. python 3.11. needs the sibling folders 02-retrieval-eval and 03-hybrid-search from this repo checkout, since their code and data are imported in place.

## what came out

first stages, full corpus scan, 100 docs, 40 queries (20 keyword, 20 paraphrase):

```
bm25                   mrr@10 0.851   keyword 0.950   paraphrase 0.752   latent dots/query     0.0
lsa                    mrr@10 0.861   keyword 0.950   paraphrase 0.773   latent dots/query   100.0
rrf                    mrr@10 0.861   keyword 0.950   paraphrase 0.772   latent dots/query   100.0
```

reranking bm25's shortlist, depth sweep (+n/-n = queries improved/hurt vs the first stage):

```
bm25+pooled-lsa@5      mrr@10 0.858   keyword 0.950   paraphrase 0.767   latent dots/query     5.0   gold in shortlist 0.925   +1/-0
bm25+pooled-lsa@10     mrr@10 0.858   keyword 0.950   paraphrase 0.767   latent dots/query    10.0   gold in shortlist 0.925   +1/-0
bm25+pooled-lsa@20     mrr@10 0.861   keyword 0.950   paraphrase 0.773   latent dots/query    20.0   gold in shortlist 0.950   +2/-0
bm25+maxsim@20         mrr@10 0.867   keyword 0.950   paraphrase 0.783   latent dots/query  1909.5   gold in shortlist 0.950   +4/-3
bm25+maxsim@50         mrr@10 0.854   keyword 0.950   paraphrase 0.758   latent dots/query  4764.7   gold in shortlist 1.000   +4/-3
bm25+maxsim@100        mrr@10 0.854   keyword 0.950   paraphrase 0.758   latent dots/query  9298.9   gold in shortlist 1.000   +4/-3
bm25+oracle@10         mrr@10 0.925   keyword 0.950   paraphrase 0.900   latent dots/query     0.0   gold in shortlist 0.925   +5/-0
bm25+oracle@20         mrr@10 0.950   keyword 0.950   paraphrase 0.950   latent dots/query     0.0   gold in shortlist 0.950   +6/-0
bm25+oracle@50         mrr@10 1.000   keyword 1.000   paraphrase 1.000   latent dots/query     0.0   gold in shortlist 1.000   +8/-0
```

paired bootstrap over per-query rr@10, 10000 resamples, 95% ci:

```
bm25+pooled-lsa@20 vs bm25             diff +0.011   95% ci [+0.000, +0.029]   p_le_zero 0.1287
bm25+pooled-lsa@20 vs rrf              diff +0.000   95% ci [+0.000, +0.001]   p_le_zero 0.3618
bm25+maxsim@20 vs bm25                 diff +0.016   95% ci [-0.042, +0.075]   p_le_zero 0.3157
oracle@20 vs pooled-lsa@20             diff +0.089   95% ci [+0.025, +0.160]   p_le_zero 0.0021
```

four results worth stating plainly.

**reranking 20 candidates reproduced the full dense scan exactly.** bm25+pooled-lsa@20 lands on the same reciprocal rank as scanning all 100 docs with the bi-encoder, on every single query, and ties rrf fusion, at 20 latent dots per query instead of 100 and with zero demotions. a test pins the per-query identity. thats the whole economic argument for two-stage retrieval in one row: the cheap lexical stage does the recall work, the dense scorer only pays for precision where it matters. but note the honest caveat one line down: the +0.011 over plain bm25 has p_le_zero 0.1287, so on 40 queries the gain itself is not established, only the cost saving is.

**finer interaction, ~95x the cost, nothing you can measure.** MaxSim over per-term vectors from the very same LSA fit is the top real row in the table at depth 20, 0.867 against pooled-lsa's 0.861 and bm25's 0.851 — and that is not a result. the paired bootstrap on the gap it looks best on, +0.016 over bm25, gives ci [-0.042, +0.075] and p_le_zero 0.3157, so on 40 queries all three real scorers are one blur. what the numbers do carry is the price: 1909.5 latent dots per query against the pooled scorer's 20.0, about 95x, for a difference the data cant separate from zero. it still demotes 3 paraphrase queries (p11, p17, p18) while promoting 4, and it goes the wrong way with depth — 0.867 at 20, 0.854 at 50 and past — because every extra candidate is another chance for one noisy term-to-term max to outrank the pooled document context. untrained single-term LSA vectors are the reason: real late-interaction models train the term vectors for exactly this interaction, and granularity without training buys variance, not rank.

**keyword queries are immune to every scorer, by mechanism.** the keyword column reads 0.950 for every system in the table. an exact term match has cosine 1.0 in maxsim, so a doc containing all query terms sums to the query term count — the most any doc can score, since every per-term max is a cosine — and docs that reach that ceiling tie there while the stable sort resolves ties by first-stage order. the reranker structurally cannot damage what the lexical stage already got right, which is a property you want and normally have to engineer on purpose.

**the headroom is in the scorer, not the shortlist.** at depth 20 the shortlist already contains the gold doc for 95% of queries, and the oracle turns that into mrr 0.950. the gap between the oracle and the pooled scorer, +0.089 with ci [+0.025, +0.160], is the only gap in the table that clears zero — every comparison between two real scorers straddles it. so on this corpus a better shortlist buys almost nothing (deepening 20 to 50 moves the oracle 0.950 to 1.000) while a genuinely better pair scorer has 9 points of mrr sitting on the table. thats the case for a trained cross-encoder, priced without simulating one.

two smaller things. direction matters: rescoring lsa's shortlist with the weaker bm25 scorer gives back lsa's paraphrase wins (0.851, +0/-2), so "add a reranker" is never free, the scorer has to be better than the stage under it. and k14 ("GIL", the acronym the corpus only spells out) scores rr 0 under every real system: bm25 matches nothing, the term is out of vocabulary for both dense scorers, and even the oracle needs depth 50 before the gold doc drifts into the shortlist on tie order. reranking cannot manufacture a signal that is not there, 25's query rewriting remains the only thing in this repo that rescues that query.

## why python

this project is glue over 02's metrics and 03's retrievers, which are numpy and scikit-learn. the term vectors come out of a fitted TruncatedSVD, the scorers are small matrix products, and the right tool for that is the stack the models already live in.

## where it breaks down

- 40 queries is enough to expose direction and mechanism, not to certify a +0.011. the bootstrap says so out loud, and the one comparison that does clear zero is against an oracle no real scorer reaches.
- the corpus is 100 docs, so the full dense scan this project economizes away costs 100 dots. the two-stage argument gets real at the scale where the first stage is an ann index (13) and a full scan is off the table; the ceiling and cost mechanics measured here transfer, the absolute savings do not.
- the maxsim result is about untrained term vectors, not late interaction in general. its the control condition colbert-style training exists to fix, and the honest reading is a cost verdict, not a quality one — 40 queries cannot rank three scorers this close.
- one gold doc per query makes mrr and the ceiling crisp, but graded relevance would blur the oracle: with multiple partially-relevant docs "gold in shortlist" stops being binary.

## fixes

- 2026-09-02 — the maxsim scorer was not maxsim. colbert sums each query term's
  best cosine unweighted, this took an idf-weighted mean — weighting hardest the
  rare terms a 64-dim LSA collapses onto shared directions. now the plain sum.
  maxsim@20 0.838 → 0.867, from under bm25's 0.851 to over it, @100 0.825 →
  0.854, the vs-bm25 bootstrap -0.013 → +0.016. the "granularity just adds
  variance" bullet was reading the weighting, not the representation.

## open questions

- the oracle says 9 points of mrr sit between pooled-lsa and perfect at depth 20. could a trained pair scorer capture part of it with the features already computed here (bm25 score, pooled cosine, maxsim) fit on held-out queries, and does 40 queries even support the split?
- what happens to the rerank knee when the first stage is 13's hnsw instead of an exact scan: ann recall@depth is below 1.0 by construction, so the ceiling and the ef knob should trade against each other measurably.
- maxsim spends 1909.5 dots at depth 20, mostly on low-idf doc terms that can never win a max. how much of that cost does idf-pruning doc profiles recover before mrr moves?
