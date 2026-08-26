# 03 — hybrid search: bm25 + dense, and when each one wins

project 02 ended on the two paraphrase queries lexical retrieval cant reach — this one goes after them. two retrievers built over the same 100-doc corpus, measured head to head, then fused. bm25 implemented from scratch — the actual okapi formula, not a wrapper. the dense side is tf-idf + truncated svd (classic LSA), which is the fully offline stand-in for an embedding model — no api key, no model download, runs anywhere. both sides share one tokenizer so the comparison measures retrieval, not tokenization.

a note on the second bm25 — project 02 also implements okapi bm25, and this one is deliberately separate rather than imported. it has to sit on 03s stemming/compound-splitting tokenizer so the lexical and dense sides see identical tokens, and it returns full score vectors for fusion instead of 02s top-k lists. the scoring itself is pinned to agree with 02: same lucene +1 idf, same k1/b defaults, and repeated query terms count once — both projects carry a test holding that last contract, because two bm25s in one repo that silently disagree on "cache cache" vs "cache" is exactly the kind of bug that erodes trust in every number downstream

## the concept

lexical search matches the words you typed. dense search matches what the words tend to mean, because svd squeezes the term space into latent dimensions where words that co-occur across the corpus land close together — kill/terminate, folder/directory. that buys you paraphrase queries and costs you precision on exact identifiers. hybrid search runs both and fuses the rankings, betting that their failure modes dont overlap.

two fusion strategies here:

- **reciprocal rank fusion** — score each doc by 1/(60+rank) summed across retrievers. ignores score magnitudes entirely, so no normalization headaches
- **weighted blend** — min-max normalize both score arrays, then alpha·dense + (1−alpha)·bm25. keeps magnitudes, needs normalization, gives you a knob

the golden query set is split by intent: 20 keyword queries (terse identifier lookups — `OOMKilled`, `force-with-lease`, `502 bad gateway`) and 20 paraphrase queries that describe the problem without using the answer docs vocabulary ("force a program that stopped responding to die" → the SIGKILL doc). the corpus is written so paraphrase-query words appear in sibling docs, not the target — thats what gives the latent space something to bridge and bm25 something to trip on. curated on purpose, and the numbers below should be read that way.

## how to run

```
cd 03-hybrid-search
pip install -r requirements.txt
python3 main.py
python3 -m pytest tests/
```

no network, no api key. svd is seeded, so every run prints the same numbers.

## the numbers

```
ALL QUERIES (40)          recall@1    recall@5    mrr@10
bm25 (lexical)               0.812       0.950     0.882
dense (lsa)                  0.812       0.975     0.897
hybrid (rrf)                 0.838       0.950     0.899

PARAPHRASE ONLY (20)      recall@1    recall@5    mrr@10
bm25 (lexical)               0.625       0.900     0.765
dense (lsa)                  0.625       0.950     0.794
hybrid (rrf)                 0.675       0.900     0.799
```

mrr is cut off at rank 10, same as 02 — every ranking here covers all 100 docs, so without a cutoff nothing is ever a miss and the metric cant say "didnt find it". bm25s worst query sits at rank 12 and was booking 0.083 for it

- keyword queries: both sides go 20/20 at rank 1. more on why thats interesting below
- paraphrase queries: bm25 gets trapped by surface-word collisions — "check who is logged in without a trip to the database" lands on the connection-pooling doc (database! trip!) and doesnt reach the JWT doc until rank 12, past the cutoff, so it scores zero — dense has it at 8. dense wins the category on mrr@10 and recall@5
- hybrid rrf has the best mrr@10 and recall@1 overall — it recovers several of bm25s paraphrase misses without giving up the keyword wins
- the alpha sweep prints mrr@10 at every blend from pure-bm25 to pure-dense. best value on this set is 0.2, but with 40 queries thats reading tea leaves — the sweep is there to show the tradeoff curve exists, not to pick a production constant

## the honest finding about keyword queries

i expected dense to stumble on exact identifiers — thats the standard story for why you keep bm25 around. it didnt happen here, and the reason matters: LSA is fit on this corpus, so `ECONNREFUSED` is a first-class dimension of the model. it literally cannot be out of vocabulary. the keyword failure mode you see in production belongs to pretrained neural embedders, where a rare token gets shredded into subwords the training distribution barely saw. so what the keyword category actually measures here is the other production question — does adding a dense retriever degrade exact lookup — and the measured answer is no

## tradeoffs

- rrf is rank-blind. when one retriever is confidently right and the other is confidently wrong, rrf averages them — you can see it drag a dense rank-4 hit down to rank-7 hybrid when bm25 had it at 10. the weighted blend can lean toward the stronger side, but now you own a hyperparameter and a normalization scheme
- the tokenizer keeps hyphen compounds whole and also splits them — `force-with-lease` stays searchable as a flag while `logged-in` still matches "logged". skip the split half and compound words silently stop matching their parts. this is the same tradeoff elasticsearchs word-delimiter filter exists for
- the stemmer is ~30 lines of suffix stripping. it maps cache/caching/cached together, which is all this corpus needs — it also cant tell that slow and slower are related, so a query using the comparative form just loses that term

## fixes

- 2026-08-26 — mrr had no rank cutoff while 02 reports mrr@10, so the same
  metric name meant two things across the repo — and since rankings here cover
  all 100 docs, a query bm25 only answered at rank 12 still scored 0.083
  instead of missing. now cut off at 10 like 02. bm25 0.885 → 0.882, rrf
  0.902 → 0.899, paraphrase bm25 0.769 → 0.765, paraphrase rrf 0.803 → 0.799

## where it breaks down

- 100 docs is a toy. LSA needs co-occurrence to learn synonymy, and on a corpus this small a synonym that never co-occurs with its partner is invisible — a real system uses a pretrained embedder precisely because it imports word knowledge from outside your corpus
- svd refit is the update story: add documents and the latent space is stale until you refactorize the whole matrix. fine at 100 docs, a nightly batch job at a million
- the dataset is authored and curated, and the absolute numbers wont transfer anywhere. what transfers is the shape: lexical wins exact identifiers for free, dense wins vocabulary mismatch, fusion buys insurance on both — and you should measure your own corpus with exactly this kind of split instead of trusting anyones benchmark, including this one
