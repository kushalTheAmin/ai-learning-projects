# 23-multi-hop-retrieval

iterative two-hop retrieval over bm25, measured against single-shot retrieval on questions whose answer doc shares almost no vocabulary with the question. everything here is authored and offline: the 28-doc corpus is a fictional ops wiki i wrote so that each fact needs a hop (capability words live in one doc, infrastructure facts in another, joined only by a service name), the 32 golden queries and their gold docs are hand-labeled, and there is no model anywhere, the "bridge extractor" is a tf-idf heuristic. so the headline numbers measure how the multi-hop mechanism behaves on a corpus built to have the two-hop shape; they say nothing about retrieval quality on real data, and the near-perfect bridge extraction rate is partly a property of how distinctive i made the service names.

## the idea

some questions cannot be answered by one retrieval call, not because the retriever is weak but because no single document connects the question to the answer. "which postgres cluster stores the data behind invoice generation" needs doc A (invoice generation is ledgerd) and doc B (ledgerd uses the pgledger cluster). the question shares vocabulary with A, the answer lives in B, and B only shares generic words like postgres and cluster with the question, which every database doc in the corpus also has.

the fix here is the classic iterative loop: retrieve with the question, read the top doc for whatever it talks about that the question doesnt (top tf-idf terms not in the question), append those terms to the query, retrieve again, and round-robin merge the two rankings. no model reads anything; the extraction is a bet that the bridge entity is the top doc's most distinctive novel vocabulary. this is pseudo-relevance feedback pointed at a two-hop task, and it inherits PRF's known failure: extract from the wrong doc and hop 2 chases the wrong entity. the eval measures that drift instead of hoping it away.

## run it

```
pip install -r requirements.txt
python main.py
python -m pytest tests/ -q
```

python 3.11+, stdlib only at runtime. `02-retrieval-eval` must sit next to this folder: bm25, the tokenizer, the metrics, and the paired bootstrap are imported from there, because multi-hop changes how many times you query the index and what the queries say, not how the index scores.

## what came out

```
system        recall@1  recall@5   mrr@10   pair@5  searches
single           0.083     0.667    0.323    0.667      1.00
iter-append      0.083     0.958    0.403    0.958      2.00
iter-focus       0.083     1.000    0.414    1.000      2.00
oracle           0.083     0.958    0.415    0.958      2.00

paired bootstrap on answer mrr, 95% ci over 24 two-hop queries
  iter-append vs single      diff +0.080 [+0.043, +0.119]  p(diff <= 0) = 0.0000  clears zero: yes
  iter-focus vs iter-append  diff +0.010 [-0.011, +0.032]  p(diff <= 0) = 0.1895  clears zero: no
  oracle vs iter-append      diff +0.011 [+0.000, +0.028]  p(diff <= 0) = 0.1275  clears zero: no
```

single-shot leaves the answer doc out of the top 5 on a third of the two-hop queries; both iterative modes close that to 0.958 and 1.000, and pair@5 (both gold docs in the top 5, which is what a reader needs to actually justify the answer) moves the same way, 0.667 to 0.958. the paired bootstrap on per-query answer mrr says that gap is real on this set: +0.080 [+0.043, +0.119], p(diff <= 0) = 0.0000. the price is exactly 2.00 searches per query instead of 1.00, serial, so double retrieval latency.

that is the one comparison here that clears zero. every system-vs-system gap now prints with its interval, because 24 queries is not many and the two gaps between the iterative modes both straddle zero — read the ordering of the middle rows and you are reading noise.

recall@1 is 0.083 for every system, including the oracle, and thats structural: the combined ranking leads with hop 1's top doc, which on a two-hop question is the capability doc, not the answer. the only queries where the answer sits at rank 1 are the two where it leaked (below). if a downstream reader consumed only the top 1 result, no amount of better hopping would help under this merge; the interleave trades rank-1 sharpness for never dropping what hop 1 already found.

three things i didnt author on purpose but the harness surfaced:

- **the focus-vs-append ordering is 4 queries wide and doesnt survive a resample.** hop-2 with the bridge terms alone hit 1.000 recall@5 against append's 0.958 — that whole gap is t03 and nothing else. on answer mrr the paired bootstrap puts focus over append at +0.010 [-0.011, +0.032], p(diff <= 0) = 0.1895, so the ordering is not distinguishable from zero. only 4 of 24 queries move at all and t10 moves the other way, append over focus by 0.133. t03 is still a clean look at the mechanism — the question's email words pulled the deliverability primer into the append hop 2 and the answer sank to rank 6 — but "keeping the question for context drags distractors back in" is a hypothesis this set cant settle, and one query is what it rests on.
- **oracle equals extracted almost everywhere.** gold bridge coverage is 0.958 (23 of 24), so scripted extraction is nearly free on this corpus, and oracle over append is +0.011 [+0.000, +0.028] — the same too-close-to-call as above, which is the point. the one miss is t01, where hop 1's top doc was the postgres tuning guide and the extractor faithfully pulled autovacuum, bloating, buffers.
- **the drift trap fired once and cost nothing.** conditioned on hop 1's top doc: gold on 21 queries (mrr 0.350), the answer doc itself on 2 (leak, mrr 1.000, questions whose attribute words were distinctive enough that no hop was needed), and a genuinely wrong doc once (mrr 0.333). that one poisoned hop 2 was an echo: autovacuum and friends have document frequency 1, they point straight back at the tuning guide hop 1 already ranked, and the interleave dedups it. drift damages you when the wrong doc's distinctive vocabulary is shared by yet more wrong docs, a topic cluster, not a vocabulary island. my corpus has islands, so the failure i designed for mostly refused to happen.

the 8 single-hop control queries run through the same blind pipeline (nothing routes "this needs one hop"): mrr stays 1.000 under both iterative modes, so on this corpus the second hop never hurt an easy query, it just doubled its cost. 2.00 searches for zero gain is the router argument in one line.

## tradeoffs and where it breaks

- doubling searches per query is the whole cost story here because retrieval is cheap and local. with a real vector store plus reranker per hop, 2x latency serial is the argument for routing only suspected multi-hop queries into the loop, and the controls show the loop itself wont tell you which ones those are.
- tf-idf extraction worked because the bridges are single rare tokens i invented. real bridge entities are multi-word, inflected, and share tokens with everything ("the payments service"); extraction quality is the ceiling on this whole approach and here it was gifted, not earned.
- two hops are hardcoded. a third hop means another extraction from an already-diluted query, and drift compounds per hop; nothing here measures that.
- the interleave cannot rank the answer first on a true two-hop question by construction. a scorer that re-ranks the merged pool (or just leads with hop 2 when a bridge was found) would trade safety for sharpness; unmeasured.
- lexical retrieval end to end. paraphrase questions with zero token overlap fail at hop 1 before any hop logic matters, same wall as 02 and 03.

python was the right language: the entire bm25/metrics/bootstrap stack this builds on lives in 02-retrieval-eval, and reimporting it keeps two-hop scoring semantics identical to the single-hop baseline by construction instead of by promise.

## fixes

- 2026-09-01 — "iter-focus beats iter-append" was published as a result, bolded,
  with a design lesson on it, off a mean gap read straight from the table while
  the paired bootstrap two paragraphs up was only ever pointed at
  iter-append vs single. the gap is +0.010 [-0.011, +0.032], p(diff <= 0) =
  0.1895 — it straddles zero, 4 of 24 queries move at all, t10 moves the other
  way, and the 0.958 -> 1.000 recall@5 headline is one query (t03). every
  system-vs-system gap runs through `compare_rr` now and prints with its
  interval and whether it clears zero. no measured number moved — the table is
  what it was, the two iterative rows just stopped being an ordering.

## open questions

- drift cost nothing here because the trap doc was a vocabulary island. a corpus with topic clusters (several tuning guides sharing jargon) should make the poisoned hop 2 actively harmful instead of an echo; that dataset is the missing measurement.
- the merge is a fixed interleave. re-scoring the merged pool with the hop-2 query, or leading with hop 2 when extraction confidence is high, would attack the structural recall@1 floor of 0.083; needs a confidence signal for extraction first.
- extraction confidence itself: the tf-idf margin between the top novel term and the runner-up looks like a router signal (route to hop 2 only when the top doc has something distinctive to say). would it have skipped the 8 controls and t01?
- hop 2 conditions on exactly one doc, hop 1's top. extracting from the top 3 docs and merging term sets would hedge the t01 failure at the cost of more drift surface; the tradeoff is unmeasured.
- a real embedder under the same harness (the recurring thread from 03, 12, 13, 15, 18, 20) would test whether dense hop-1 retrieval reduces bridge-extraction misses or just moves the failure to paraphrased bridges.
