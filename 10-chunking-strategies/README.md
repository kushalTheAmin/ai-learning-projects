# chunking strategies, measured on retrieval quality

fixed-size windows vs sentence-packed chunks vs overlap, all indexed with the
same BM25 and scored on whether retrieval can hand back the one sentence that
answers each question. the corpus and the questions are authored for this
project: 10 fake but realistic ops documents (runbooks, postmortems, design
docs) and 40 gold queries, each pointing at the exact sentence in the exact doc
that answers it. nothing here touches a model or the network, and the headline
numbers measure retrieval over this committed corpus, not chunking in general;
a different corpus with shorter answer sentences would be kinder to fixed
windows than this one is.

## what it does

- splits each doc three ways: fixed windows of n words, fixed windows with
  overlap, and whole sentences greedily packed up to a word budget
- indexes every chunk with the BM25 implementation imported from
  `02-retrieval-eval` (chunking changes what goes into the index, not how
  scoring works, so the scorer is reused rather than rewritten)
- scores each query by exact answer containment: a chunk is relevant only if
  the full answer sentence survives inside it, so a chunk boundary through the
  middle of the answer counts as a miss
- also measures what the miss costs: for every split answer, how much of it the
  best chunk still holds

## the concept

chunking is where retrieval quality is quietly decided, before any embedding or
ranking runs. a chunk is the unit of retrieval and the unit of context, so a
boundary in the wrong place does two kinds of damage: it splits the fact you
need across two chunks so neither scores well, and it means even a correct
retrieval hands the model half a fact. fixed-size windows are the default
everywhere because they are trivial and predictable. this project prices that
default.

## how to run

```
cd 10-chunking-strategies
pip install -r requirements.txt
python main.py
python -m pytest
```

python 3.11+, stdlib only at runtime, pytest to test. `02-retrieval-eval` must
sit next to this folder in the repo checkout, since the BM25 comes from there.

## the numbers

```
config           chunks  w/chunk idx words  split%  hit@1  hit@5  mrr@10  ctx w@5
---------------------------------------------------------------------------------
fixed-40            140     38.5      5391   67.5%  0.225  0.300   0.263    197.3
fixed-80             72     74.9      5391   42.5%  0.400  0.500   0.445    388.2
fixed-160            39    138.2      5391   25.0%  0.575  0.725   0.640    755.8
fixed-80/ov-20       92     76.4      7031    7.5%  0.525  0.775   0.632    388.8
fixed-80/ov-40      130     78.4     10191    2.5%  0.450  0.800   0.578    395.4
sentence-40         186     29.0      5391    0.0%  0.475  0.675   0.558    144.6
sentence-80          82     65.7      5391    0.0%  0.600  0.850   0.698    333.7
sentence-160         40    134.8      5391    0.0%  0.650  0.925   0.771    685.3
```

split% is the share of the 40 answers that no chunk fully contains. hit@k asks
whether any relevant chunk landed in the top k. ctx w@5 is the words you would
stuff into a prompt if you passed the top 5 chunks along.

what the table says:

- boundary placement is most of the story. fixed-80 misses 20 queries at k=5
  and 17 of those misses are split answers, not ranking failures. the retriever
  never got a chunk worth ranking.
- sentence packing costs nothing and fixes all of it. same index size (5391
  words, no duplication), 0% splits at every budget, and sentence-80 beats
  fixed-80 on every quality column: hit@5 0.850 vs 0.500, mrr@10 0.698 vs
  0.445, with a smaller context bill (333.7 vs 388.2 words).
- overlap is the expensive version of the same fix. fixed-80/ov-20 recovers 15
  of the 17 splits for +30.4% index size, ov-40 gets 16 of 17 for +89.0%. and
  overlap moves every boundary rather than only adding windows: the stride
  shrinks from 80 to 60 words, so ov-20 newly splits one answer that plain
  fixed-80 kept whole. i expected overlap to strictly dominate, the code says
  otherwise.
- a split is not a total loss, which is why real pipelines get away with fixed
  windows. the best chunk still holds 71.1% of a split answer on average at
  fixed-80. this projects containment metric scores that as zero; a model
  reading the chunk might still answer from the surviving piece, and measuring
  that needs a model in the loop.
- bigger chunks trade precision for recall and you pay for it in context.
  fixed-160 nearly doubles ctx w@5 vs fixed-80 (755.8 vs 388.2, 1.95x) to buy
  its recall, and sentence-160 pays slightly more than double for the same
  trade at 0 splits (685.3 vs 333.7, 2.05x). per word of prompt, sentence-80
  is the efficient point on this corpus.
- the keyword vs paraphrase gap survives every chunking choice: sentence-80
  scores mrr@10 0.879 on keyword queries and 0.517 on paraphrase. chunking
  fixes boundary damage; it cannot make BM25 understand synonyms. that failure
  mode belongs to 03s dense retrieval story, not to chunking.

## fixes

- 2026-08-29 — the context bullet said fixed-160 "more than doubles" ctx w@5
  vs fixed-80, but the two numbers in the same sentence are 755.8 vs 388.2 —
  1.95x, not over 2x. the pair that does more than double is sentence-160 over
  sentence-80 (2.05x), which the bullet called "the same trade". both multiples
  are stated now and pinned by a test. no measured number moved.

## why python

the retrieval machinery this builds on (02s BM25, tokenizer, metrics) lives in
python, and importing it beats reimplementing it in another language just to
chunk strings. the interesting code here is offset arithmetic and a sentence
splitter; python carries both fine and the ecosystem this slots into (rag
pipelines) is python-first anyway.

## where it breaks down

- the sentence splitter is a regex with an abbreviation list. it survives e.g.,
  i.e., decimals, and dotted names like logs.raw, but a corpus with quoted
  dialogue, code blocks, or markdown tables would need a real segmenter, and
  cjk text has no capitalization signal at all so it would never split.
- answers here are single sentences, so sentence chunking can never split one
  by construction. facts that span two or three sentences would blunt its
  advantage and favor overlap; that shape is authorable but not authored here.
- exact containment is a hard-edged relevance rule. it makes the boundary
  damage visible and the eval deterministic, but it treats a 95% chunk as a
  total miss, which understates fixed chunking against any reader tolerant of
  partial facts.
- 40 queries is enough to see the ordering but not to resolve close calls; the
  bootstrap machinery in 02 could put intervals on these gaps and was not run
  here.

## open questions

- multi-sentence answers: at what answer length does sentence packing start
  splitting facts too, and does overlap-on-sentences beat overlap-on-words
  there?
- the containment cliff: how often does a model actually answer correctly from
  a 71% chunk? needs a model in the loop, and would turn split% from a proxy
  into a measured cost.
- 02s paired bootstrap on these deltas: is hit@5 0.850 vs 0.775 (sentence-80 vs
  fixed-80/ov-20) a real gap on 40 queries or noise?
- semantic chunking (split where topic shifts, not where the word counter
  says) is the fashionable answer; measuring it against sentence-80 on this
  corpus needs an embedder, which is exactly what this repo does not have yet.
