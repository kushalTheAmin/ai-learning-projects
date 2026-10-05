# 07 near duplicates

minhash with lsh banding vs simhash for near-duplicate detection, measured against exact jaccard ground truth on a labeled corpus.

everything here is authored and offline. the 24 base documents are short paragraphs i wrote about infrastructure topics, and the duplicates are manufactured by five seeded mutation functions (typos, dropped words, shuffled sentences, truncation, case and whitespace noise). so the headline numbers measure how well each sketch recovers duplicates of these specific mutation shapes at these specific similarity levels. they do not tell you the recall of minhash on real scraped web pages, where the duplication patterns, document lengths, and similarity distribution are all different. what does transfer is the machinery: the estimator error scaling, the s-curve math, and the failure modes are properties of the algorithms, not the dataset.

## the idea

comparing every document to every document is quadratic and each comparison touches full shingle sets. dedup at scale needs both costs gone. minhash compresses a shingle set into k small integers whose match rate is an unbiased estimate of jaccard similarity. lsh banding then splits that signature into b bands of r rows and buckets documents by band, so candidate pairs fall out of hash lookups instead of pairwise scans, with collision probability 1 - (1 - s^r)^b at similarity s. simhash goes further and compresses the whole document into one 64-bit fingerprint where similar documents land at small hamming distance. this project builds all three layers from scratch and measures what each compression step costs in accuracy.

## run it

```
pip install -r requirements.txt
python3 main.py
python3 -m pytest -q
```

no api key, no network, stdlib plus pytest. runs in about half a second.

## what came out

corpus: 24 base docs x 5 mutations, 144 docs, 10296 pairs, 360 true duplicate pairs.

separability first. exact jaccard on 3-word shingles puts every duplicate pair at 0.280 or above (the pairs that genuinely compound two mutations sit lowest, mean 0.499 over 144 pairs; the other 96 mutant-vs-mutant pairs have a noise mutant on one side and noise is a normalization no-op, so each one restates a base-vs-mutant row rather than compounding anything, mean 0.695) while the hardest non-duplicate lands at 0.024 — cache-03 (thundering herd) against ratelimit-03 (retry hints), which is a cross-topic pair, not a same-topic one. the hardest pair that really does share a topic is index-02 vs index-03 at 0.011, less than half of it. the means say the same thing in the other direction: same-topic non-duplicates average 0.0005 over 864 pairs, cross-topic 0.0001 over 9072 — sharing a topic does move you up, 5x, but 5x of nearly nothing, and one shared turn of phrase across two topics clears the whole same-topic ceiling. topical overlap is nearly invisible at the shingle level either way; two docs about caching share vocabulary but almost no 3-word sequences. so a threshold of 0.2 gives brute-force exact jaccard precision 1.000, recall 1.000 on this corpus, and the interesting question becomes what the approximations lose.

minhash estimator error on duplicate pairs, against exact jaccard:

```
k=  8: mean abs err 0.0044 all pairs, 0.1143 duplicate pairs  (max 0.5195)
k= 16: mean abs err 0.0031 all pairs, 0.0812 duplicate pairs  (max 0.2961)
k= 32: mean abs err 0.0023 all pairs, 0.0631 duplicate pairs  (max 0.2276)
k= 64: mean abs err 0.0016 all pairs, 0.0425 duplicate pairs  (max 0.1942)
k=128: mean abs err 0.0012 all pairs, 0.0307 duplicate pairs  (max 0.1047)
```

the all-pairs column is misleadingly tiny because most pairs have similarity near zero, where the estimator can barely miss. the duplicate-pairs column is the honest one and shrinks like 1/sqrt(k), as the theory says it should. halving the error costs 4x the signature. the signatures are prefix-truncatable (the first k components of a 128-component signature are exactly the k-component signature), so the whole sweep comes from one signature pass.

lsh banding over the k=128 signatures:

```
b=64 r= 2: 50% collision at s=0.104  candidates  360 (3.5% of pairs)  dup recall 1.000  precision 1.000
b=32 r= 4: 50% collision at s=0.383  candidates  329 (3.2% of pairs)  dup recall 0.914  precision 1.000
b=16 r= 8: 50% collision at s=0.674  candidates  137 (1.3% of pairs)  dup recall 0.381  precision 1.000
b= 8 r=16: 50% collision at s=0.856  candidates   60 (0.6% of pairs)  dup recall 0.167  precision 1.000
```

the knob that matters is where the s-curve sits relative to your lowest real duplicate - and how steep it is once it gets there. b=64 r=2 puts its 50% collision point at 0.104, below the 0.280 floor, and its candidate set turns out to be exactly the 360 labeled pairs: verified with exact jaccard it matches brute force (precision 1.000, recall 1.000) with 360 verifications instead of 10296, 3.5% of the comparison work. move one step to b=32 r=4 and the 50% point (0.383) crosses the floor, 31 true pairs are never generated as candidates, and no amount of verification gets them back: recall 0.914.

that threshold placement is 9 of the 31, not all of it. only 20 of the 360 true pairs sit below 0.383, so bucketing every pair above that point would still leave recall at 0.975 - the placement caps recall 0.025 below perfect and the published reading is 0.086 below. the other 22 of the 31 are misses *above* the 50% point, tail losses on a shallow curve rather than consequences of where it sits: the highest is ratelimit-02--drop vs ratelimit-02--shuffle at jaccard 0.581, which the curve gives a 0.979 chance of bucketing and which went the other way. summed over all 360 pairs the curve predicts 35.2 misses against the 31 observed, so nothing here is misbehaving - 1 - (1 - s^4)^32 is a probability and a 50% point is not a cutoff. at the floor it is 0.179, at 0.462 still only 0.775.

the per-kind breakdown shows who pays. the genuinely compounded mutant-vs-mutant pairs at 0.812, and every one of the 20 sub-0.383 pairs is one of those. typo pairs at 0.917 - and the whole typo range is 0.462 to 0.722, entirely above the 50% point, so being above the curve does not mean caught. lsh recall failures are silent and skewed low, and the two causes need separating before you reach for a fix, because they want different fixes: a lower 50% point for the first nine, more bands or probes for the other twenty-two.

simhash, one 64-bit fingerprint per document:

```
duplicate pairs: mean distance 12.7  non-duplicates: mean 31.9  min 19
d<= 8: precision 1.000  recall 0.203  f1 0.337  (73 predicted)
d<=16: precision 1.000  recall 0.717  f1 0.835  (258 predicted)
d<=20: precision 0.952  recall 0.933  f1 0.942  (353 predicted)
```

the means separate cleanly but the tails overlap: the widest duplicates sit past the nearest non-duplicates, so no threshold is clean. best f1 is 0.942 at d<=20, already past the closest non-duplicate at distance 19. head to head: minhash lsh + verify 1.000, simhash 0.942, on a corpus where both get the easy 90% for free. the gap is the tails.

## tradeoffs

minhash + lsh keeps a tunable estimate of jaccard and a tunable candidate curve, at 128 integers per doc plus b hash tables. simhash spends 8 bytes per doc, and hamming balls can be indexed with bit-permutation tables, which is why crawlers use it at web scale. but it has no verification story of its own (the fingerprint cannot re-derive similarity, you need the original shingles anyway) and its distance distribution squeezes 0..1 similarity into 64 bits, so thresholds are coarse and the dup/non-dup overlap here is structural, not bad luck. the pipeline shape that works is lsh for candidates, exact jaccard for verdicts; the sketch narrows the search, it should not issue the verdict.

## where it breaks

- everything is in memory and all-pairs exact jaccard is the ground truth. that scaffolding is quadratic and exists only because the corpus is small enough to afford truth. at real scale you can measure candidate counts but not recall, because nothing can tell you what lsh silently skipped.
- 3-word shingles on 70-word docs give ~70 shingles per doc. minhash variance at that set size is fine, but simhash with 70 voters per bit is noisy; on tweet-length docs both sketches degrade badly and on book-length docs shingle sets are huge and everything sharpens.
- ground truth is provenance, not meaning. a paraphrase that rewrites every sentence shares provenance and near-zero shingles; nothing lexical catches it. thats the semantic-similarity boundary of this whole family.
- the tokenizer treats any script without spaces as whole-run tokens, so cjk text effectively shingles per sentence-run. pinned by a test as a known limitation, the corpus is english.

## why python

the ml-adjacent dedup literature and tooling (datasketch, spark minhash) live here, and the project is set arithmetic over big integers, which python does natively with zero dependencies; the whole thing is stdlib plus pytest and runs offline. the typescript version would spend its effort fighting 64-bit integer hashing in a language with 53-bit doubles.

## fixes

- 2026-10-05 — all 31 pairs the mistuned banding misses were credited to
  its 50% collision point (0.383) sitting above the duplicate floor
  (0.280). that accounts for 9 of them. only 20 of the 360 true pairs are
  below 0.383, so threshold placement caps recall at 0.975 and the other
  22 misses are above the 50% point - tail losses on a shallow curve, the
  highest at jaccard 0.581 where the curve gives 0.979. the pipeline
  section prints the split now, plus the curve's own prediction (35.2
  misses over the 360 pairs against 31 observed) as the control that
  separates the two. the claim that any single-mutation kind above the curve
  holds recall 1.000 is gone with it - typo pairs run 0.462 to 0.722, all of
  it above the 50% point, and they sit at 0.917. no measured number moves:
  recall is still 0.914, the 31 is still 31, every per-kind row is
  unchanged, the split is new output

- 2026-09-03 — the `mutant-mutant` category was 40% padding. the `noise`
  mutation only swaps case and doubles spaces, both of which `normalize`
  undoes, so all 24 noise mutants shingle identically to their base and
  `X--noise vs X--typo` is the `X vs X--typo` comparison restated - 96 of the
  240 pairs, filed under a label the readme read as compounding two
  mutations. `pair_kind` splits them into `noise+mutant` now. mistuned-lsh
  recall on the genuinely compounded pairs is 0.812, not the published 0.879;
  simhash 0.861, not 0.908; separability mean 0.499 over 144 pairs, not 0.577
  over 240, and its max drops 0.939 → 0.708 (0.939 was the base-vs-shuffle max
  wearing a noise label). the duplicate floor 0.280 and the 31 missed pairs
  are unchanged

- 2026-08-28 — the hardest non-duplicate was printed with a hardcoded
  "(same-topic vocabulary overlap)" label and the readme repeated it as "two
  same-topic paragraphs about limiters", but the pair is cache-03 vs
  ratelimit-03 - two different topics. `topic` was in `docs.jsonl` all along
  and `load_base_docs` threw it away, so nothing could check. `Doc` carries
  `topic` now and the entry point derives the label instead of asserting it,
  plus prints the hardest genuinely same-topic pair and both means. hardest
  non-duplicate still 0.024, now labelled cross-topic; same-topic ceiling is
  0.011, means 0.0005 same vs 0.0001 cross. no measured number moved

## open questions

- the s-curve placement was tuned knowing the duplicate floor (0.280), which real pipelines never know. what does an adaptive scheme look like, sampling candidate similarities to pick b and r online?
- of the 31 missed pairs at b=32 r=4, 9 sit below the curve's 50% point and 22 are tail losses above it. multi-probe lsh claims to buy back recall without more tables, but it probes near-miss buckets, which is the second group; how much of the 0.086 gap does it actually reach, and at what probe cost?
- simhash used unit weights per shingle. idf weighting is what the original paper does; does it pull the duplicate and non-duplicate hamming distributions apart enough to close the f1 gap?
- band buckets here are exact tuples in dicts. at billions of docs the tables themselves are the memory problem; what do the bucket-size distributions look like and when do hot buckets (boilerplate shingles) blow up the candidate count?
- exact jaccard as the verifier reuses shingle sets already in memory. in a store where fetching originals costs io, when is verifying with a bigger signature (k=512) cheaper than fetching, and what false-verdict rate does that introduce?
