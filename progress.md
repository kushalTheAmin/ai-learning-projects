# progress

State of the repo: what's finished, which mechanisms already exist anywhere
in it, and the open questions each project left behind. New work checks
MECHANISMS first so nothing gets a second, disagreeing implementation, and
OPEN THREADS for the questions worth answering next.

## COMPLETED

| project | date | mechanism |
|---|---|---|
| 04-bpe-tokenizer | 2026-08-25 | byte-level bpe from scratch: pair counting weighted by pretoken piece frequency, deterministic lexicographic tie-break, rank-ordered merge application, byte fallback, replacement-char-safe decode; merge-prefix truncation lets one training serve a whole vocab sweep; measured — vocab 256→1246 cuts heldout prose 3106→1058 tokens (2.9x cost), domain transfer with a vocab-matched control (prose-trained 1.49 vs mixed-trained 2.56 bytes/token on code at equal vocab — the domain, not the slots), script cost (cjk 9.0x english tokens/char, zero merges learned), baselines at matched vocab (word tokenizer 20.3% oov on heldout prose, char tokenizer misses 277 chars, byte-level oov is structurally 0%) |
| 02-retrieval-eval, bootstrap extension | 2026-08-25 | paired bootstrap over per-query reciprocal ranks (10000 resamples, seeded, stdlib only): 95% percentile confidence intervals on each system's mrr and on paired per-query mrr differences, plus a direction-stability fraction (share of resamples where the gap is <= 0); measured verdict — bm25 vs tf-idf +0.018 [+0.000, +0.048] includes zero, the gap rests on 2 of 38 queries even though bm25 never loses one, while bm25 vs b=0 +0.041 [+0.001, +0.091] excludes zero |
| 03-hybrid-search | 2026-08-25 | okapi bm25 from scratch + lsa dense retrieval (tf-idf → seeded truncated svd) over one shared stemmer/compound-splitting tokenizer; rrf and weighted score fusion with alpha sweep; recall@1/5 + mrr on 100 docs / 40 golden queries split keyword vs paraphrase (paraphrase mrr: bm25 0.769, dense 0.794, hybrid rrf 0.803; overall rrf best at 0.902; keyword saturated for both — corpus-fit lsa has no oov failure mode) |
| 02-retrieval-eval | 2026-08-25 | from-scratch okapi bm25 (lucene idf, k1 tf saturation, b length norm) vs sklearn-style tf-idf cosine (raw tf, smooth idf, l2 norm); evaluated with recall@1/recall@5/mrr@10 over a committed 40-doc / 38-query golden dataset, per-query head-to-head by reciprocal rank, plus a b=0 ablation isolating length normalization (mrr 0.917 tf-idf / 0.934 bm25 / 0.893 b=0); dataset includes engineered kitchen-sink distractor docs and deliberate vocabulary-mismatch queries to show where lexical retrieval fails |
| 01-structured-output | 2026-08-25 | layered JSON parse repair (fence strip, balanced-brace extraction, trailing-comma removal, python-literal fallback) + pydantic schema validation with a validation-error-feedback retry loop and hard-failure policy; benchmarked strict vs lenient vs full retry on 30 scripted-failure tickets (20.0% → 60.0% → 96.7%, 44 llm calls vs 30) |

## FINDINGS

Open issues found by review, worst first. High = wrong results or wrong
claims, medium = robustness or consistency, low = performance wrong in kind.
Fixed items stay listed with their fix date so the history reads in one place.

- [medium] 01 — `extract_balanced_object` returns only the first brace-balanced
  candidate and never tries a later one, so prose with stray braces before the
  real json ("use {placeholders} like this: {...}") is rejected outright, and a
  reply carrying two objects always yields the first. today this is documented
  in the readme and pinned by a test, but it still costs a retry on output that
  would parse — scanning every `{` and taking the first candidate that parses
  would close it. found 2026-08-25
- [low] 01 — `run.py` divides by `len(tickets)` with no guard, so an empty
  `data/tickets.jsonl` raises ZeroDivisionError instead of reporting an empty
  run. found 2026-08-25
- [low] 01 — an uppercase ```` ```JSON ```` fence misses the fence regex and is
  rescued by the extract layer instead, so the layer report in `run.py` credits
  the wrong layer for that shape. success rate is unaffected. found 2026-08-25
- [fixed 2026-08-25] 01 — `extract_balanced_object` tracked only `"` as a string
  delimiter while also feeding the `python_literal` layer, so a python-dict
  reply with an unmatched `{` or `}` inside a value had its depth count broken,
  got truncated, and was thrown away — burning a retry on output that layer
  already handles. both quote styles delimit strings now. no measured numbers
  moved: no summary in the committed dataset carries a brace

## REVIEWED

| project | last review |
|---|---|
| 01-structured-output | 2026-08-25 |

Note on the first pass: every project in the repo was committed on 2026-08-25,
so the "let it settle for 24 hours" rule would have skipped all four. Reviewed
the oldest instead (01, committed 17:44 UTC) rather than run a no-op.

## MECHANISMS

Every algorithm, metric, data structure, and technique implemented somewhere
in the repo, and where it lives. Anything on this list gets imported or
extended, not rewritten — the one sanctioned duplicate is documented below.

- layered JSON parse repair: fence strip, balanced-brace extraction, trailing-comma removal, python-literal fallback (01)
- pydantic schema validation with `extra="forbid"` (01)
- validation-error feedback retry loop with a hard-failure policy (01)
- deterministic scripted-LLM failure injection (01)
- okapi bm25: lucene +1 idf, k1 tf saturation, b length normalization (02; a documented second variant in 03 sits on 03's stemming tokenizer and returns full score vectors for fusion — scoring semantics are pinned to agree, repeated query terms count once, with a test in each project holding that contract)
- tf-idf cosine similarity: raw tf, smooth idf, l2 norm (02)
- b=0 ablation isolating length normalization (02)
- recall@k (02, 03)
- reciprocal rank / mrr (02, 03)
- per-query head-to-head comparison by reciprocal rank (02)
- golden dataset construction: engineered kitchen-sink distractors and vocabulary-mismatch queries (02), keyword vs paraphrase category split (03)
- regex word tokenizer with stopword removal, naive suffix stemmer, hyphen/underscore compounds kept whole and split (03)
- lsa dense retrieval: tf-idf term-doc matrix → seeded truncated svd (03)
- reciprocal rank fusion (03)
- weighted score fusion with min-max normalization and an alpha sweep (03)
- linearly interpolated percentile (02)
- percentile bootstrap confidence interval on a mean (02)
- paired bootstrap over per-query differences with a direction-stability fraction (02)
- byte-level bpe: weighted pair counting, lexicographic tie-break on frequency ties, rank-ordered merge application, byte fallback (04)
- regex pretokenization with leading-space attachment, ` ?\S+|\s+` (04)
- merge-prefix vocab truncation: train once at max vocab, smaller vocabs are prefixes of the merge list (04)
- closed-vocabulary word tokenizer: top-n types by frequency plus unk, oov-rate measurement (04)
- character tokenizer with unseen-character reporting (04)
- compression metrics: bytes per token, tokens per character (04)
- token cost accounting at a parameterized price per million tokens (04)

## OPEN THREADS

- 01: the failure distribution is hand-built — what do the same three strategies score against a real model's actual failure modes and rates?
- 01: retries multiply tail latency up to 1+max_retries — where is the cost/latency crossover against constrained decoding or native structured-output modes?
- 02: would stemming help or hurt on this dataset? it fixes "password"/"passwords" but brings its own errors — 03 has a stemmer, a controlled before/after on 02's golden set is still unmeasured
- 02: scoring loops over every document per query term — at what corpus size does that actually fall over, and what does an inverted index buy, measured?
- 02: how many queries until the bm25 vs tf-idf interval excludes zero, assuming the measured per-query win rate holds? answerable by simulation (power analysis)
- 02: significance is not importance — what mrr delta actually changes downstream behavior? needs a task-level metric on top of retrieval, not more resamples
- 03: best alpha 0.2 was called "reading tea leaves" on 40 queries — 02 now has the paired bootstrap machinery to answer it, still unapplied to the fusion sweep
- 03: corpus-fit lsa cannot be out-of-vocabulary, so the keyword failure mode of pretrained embedders is unmeasured here — needs a real embedding model on the same golden set
- 03: svd refit is the whole update story — what does incremental indexing look like, and what does a stale latent space actually cost, measured?
- 04: how far are the learned merges from a production tokenizer's on identical text — fertility head to head needs a real pretrained vocab run over this corpus, my 990 merges vs their 100k
- 04: compression is not quality — a bigger vocab is cheaper per request, but whether it helps or hurts a downstream model is invisible without a model
- 04: at what corpus size does naive full-recount bpe training fall over, and what does an incremental pair-count trainer buy, measured — same shape as 02's inverted-index thread
- 04: mixed-domain training won on code without hurting prose — does that hold as domains multiply, or does a fixed vocab budget hit a crowding-out point?
- 04: script cost is measured per line and the emoji line is diluted by the english around it — a per-codepoint-class breakdown would price each script honestly

## BLOCKED

(empty)
