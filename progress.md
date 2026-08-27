# progress

State of the repo: what's finished, which mechanisms already exist anywhere
in it, and the open questions each project left behind. New work checks
MECHANISMS first so nothing gets a second, disagreeing implementation, and
OPEN THREADS for the questions worth answering next.

## COMPLETED

| project | date | language | mechanism |
|---|---|---|---|
| 11-prompt-caching | 2026-08-27 | typescript | simulated provider-side prefix cache modeling the documented semantics (longest-cached-prefix hit with exact length-prefixed keys, writes billed only for the delta past the hit, ttl expiry with free refresh-on-read at the entry's own ttl, min cacheable prefix 1024 tokens, 4-breakpoint cap, 20-block lookback per breakpoint) + read/write cost multipliers per ttl (0.1x reads, 1.25x 5m writes, 2x 1h writes over parameterized base pricing) + breakpoint placement strategies (none, static prefix, incremental tail, lookback-spaced) + seeded phrase-bank agent workload with interleaved conversations, volatile-header cache-bust variant, unique one-shot requests, and tool-heavy turns; imports 08's token estimator and 05's rng; measured — incremental breakpoints save 78.0% input cost vs no caching (hit rate 89.6%) where static-only saves 44.2%, one volatile header line drops hits 59/60 to 0/60 and lands at 1.252x of not caching, unique one-shot prompts with caching on bill exactly 1.250x, a gap sweep flips the 5m ttl from 0.246x to a pure 1.250x loss the moment turn gaps pass the ttl (1h ttl holds 0.341x until 70m, then 2.000x), and 26-block turns outrun the 20-block lookback so the naive tail breakpoint rewrites all history every turn (1.072x, worse than no caching) until one spaced marker restores 0.362x |
| 10-chunking-strategies | 2026-08-27 | python | regex sentence splitter with character spans (abbreviation guard, non-ascii-safe uppercase boundary check via str.isupper) + fixed word-window chunker with optional overlap + greedy sentence-packing chunker under a word budget, all emitting exact doc substrings with [start, end) offsets + exact answer-containment relevance over chunks with split-rate, best-coverage (char overlap of answer span with best chunk), and context-words-at-k metrics, over an authored 10-doc / 40-query ops corpus with verbatim-unique answer sentences; imports 02's bm25/tokenizer/metrics (chunking changes the index contents, not the scorer); measured — fixed-80 splits 42.5% of answers and 17 of its 20 hit@5 misses are boundary splits not ranking failures, sentence packing at identical index size (5391 words) holds splits at 0% and wins hit@5 0.850 vs 0.500 with a smaller context bill (333.7 vs 388.2 words), overlap-20 buys back 15/17 splits for +30.4% index but newly splits 1 answer plain fixed-80 kept whole (stride 60 moves every boundary, overlap does not just add windows), and a split answer's best chunk still holds 71.1% of it on average |
| 09-concurrency | 2026-08-27 | typescript | fifo counting semaphore (direct permit handoff, double-release guard, high-water/queue stats) + bounded-parallelism map over it (fail-fast and per-item settled variants, input-order results) + micro-batcher with size/deadline dual flush trigger and a batch-identity check against stale uncancellable virtual timers + simulated llm batch endpoint (80ms + 20ms/item ±10% seeded jitter, fifo admission cap 8, 400-token per-call overhead + 60/30 per-item tokens, whole-batch validation rejection naming no item) + poisoned-batch recovery strategies (fail-all, capped retry-whole, one-by-one, bisect) + seeded exponential inter-arrival process; imports 06's clock/percentile and 05's rng; measured — workers past the server cap hold 79.3 req/s while request p50 doubles per doubling (100ms at 8 workers → 793ms at 64, the queueing just moves server-side), batch 8 captures 90% of batch 32's overhead amortization ($1.830 → $0.780 per 1k items) at a third of its p50 (239ms vs 724ms), holding a micro-batch open 100ms on ~20ms arrivals cuts cost 55% for +175ms p50, and bisect isolates 1 poisoned item of 32 in 11 calls vs 33 one-by-one but inverts by k=4 (31 calls and 21520 input tokens vs 17040, failing halves repay the overhead at every tree level) |
| 08-agent-tool-loop | 2026-08-27 | typescript | agent loop over zod strict-object tool schemas with hard edges: model-call budget, per-intent validation-feedback cap, loop guard that aborts at the 3rd identical invalid emission (counts invalid calls only, so legitimate duplicate valid calls pass) + scripted reactive model (authored intent lists with per-intent flaws and correction rules, a pure function of the visible history) + clean-twin flaw pricing (same task re-run with flaws stripped, delta per flaw class) + token/cost estimate at ~4 chars/token on full-history replay; imports 06's clock/backoff/retry/percentile and 05's rng, and applies 01's validation-error-feedback idea (python) per tool call inside a multi-step loop; measured — strict 10/25 vs feedback 22/25 vs guarded 21/25 completion, a one-round correction costs +1 model call and 139-218 extra tokens vs the clean twin, 3 stubborn tasks burn 3969 tokens under feedback vs 759 guarded (80.9% saved), and the guard's price is the one slow corrector (corrects after 3 rounds) it kills at the 3rd identical emission |
| 07-near-duplicates | 2026-08-27 | python | word n-gram shingling (nfkc/casefold normalization) + exact jaccard ground truth over all pairs + minhash signatures (seeded affine hash family mod 2^61-1, prefix-truncatable so one k=128 pass serves the whole accuracy sweep) + banded lsh with the 1-(1-s^r)^b s-curve + 64-bit simhash with hamming sweep + seeded mutation corpus (typo/drop/shuffle/truncate/noise, provenance ground truth); measured — dup-pair estimator mae 0.114 at k=8 to 0.031 at k=128 (~1/sqrt k), tuned banding b=64 r=2 recovers all 360 dup pairs exactly at 3.5% of brute-force comparisons, mistuned b=32 r=4 (s-curve 0.383 above the 0.280 dup floor) silently loses 31 pairs concentrated in mutant-mutant (0.879) and typo (0.917) recall, simhash best f1 0.942 vs pipeline 1.000 because the dup/non-dup hamming tails overlap (max dup distance past min non-dup 19) |
| 06-rate-limiting | 2026-08-27 | typescript | virtual-time clock (deterministic timer ordering by (time, seq), deadlock detection, run-until-settled driver) + continuous-refill token bucket shared by server admission and client pacing + backoff policies (fixed, capped exponential, full/equal/decorrelated jitter per the aws formulations) + bounded retry loop with optional retry-after compliance + simulated api with seeded latency and transient 503s; measured on a 40-client x 5-request herd against 20 req/s — no-jitter retries collide 20-wide at the same instant vs 1 jittered, but full jitter's peak-window load is higher (104 vs 61 per 100ms, mean delay is half), fixed-100ms burns 15.32 attempts/success and still fails 56.5%, retry-after makespan 9.47s vs 9.0s ideal, client pacing 1.11 att/ok with every leftover 429 downstream of 503 retries that bypass the pacing bucket |
| 05-token-streaming | 2026-08-26 | typescript | incremental sse parser over raw bytes (whatwg subset: lf/crlf/bare-cr incl. cr on a chunk boundary, streaming utf-8 decode, multi-line data, last-event-id, dispatch only on non-empty data) + partial-json prefix parser (single left-to-right scan: container stack, in-progress token, safe-index truncation; unambiguous completion — close string, tru->true, trim 12. to 12 — else drop the dangling piece) + bounded async queue whose await-push blocks when full, with high-water/stall instrumentation; measured — first text at 2.5% of a buffering client's wait, tool-arg fields first parsed at 44-89% of stream bytes vs 100% waiting for the closing brace and first carrying a value at 44-89% too except the one object-valued field, which parses empty at 60.5% and holds a filter at 63.8%, bounded(8) queue holds high-water at 8 chunks vs 419 unbounded at identical wall time, 300/300 seeded byte-level chunkings parse identically |
| 04-bpe-tokenizer | 2026-08-25 | python | byte-level bpe from scratch: pair counting weighted by pretoken piece frequency, deterministic lexicographic tie-break, rank-ordered merge application, byte fallback, replacement-char-safe decode; merge-prefix truncation lets one training serve a whole vocab sweep; measured — vocab 256→1246 cuts heldout prose 3106→1058 tokens (2.9x cost), domain transfer with a vocab-matched control (prose-trained 1.49 vs mixed-trained 2.56 bytes/token on code at equal vocab — the domain, not the slots), script cost (cjk 9.0x english tokens/char, zero merges learned), baselines at matched vocab (word tokenizer 20.3% oov on heldout prose, char tokenizer misses 277 chars, byte-level oov is structurally 0%) |
| 02-retrieval-eval, bootstrap extension | 2026-08-25 | python | paired bootstrap over per-query reciprocal ranks (10000 resamples, seeded, stdlib only): 95% percentile confidence intervals on each system's mrr and on paired per-query mrr differences, plus a direction-stability fraction (share of resamples where the gap is <= 0); measured verdict — bm25 vs tf-idf +0.018 [+0.000, +0.048] includes zero, the gap rests on 2 of 38 queries even though bm25 never loses one, while bm25 vs b=0 +0.041 [+0.001, +0.091] excludes zero |
| 03-hybrid-search | 2026-08-25 | python | okapi bm25 from scratch + lsa dense retrieval (tf-idf → seeded truncated svd) over one shared stemmer/compound-splitting tokenizer; rrf and weighted score fusion with alpha sweep; recall@1/5 + mrr on 100 docs / 40 golden queries split keyword vs paraphrase (paraphrase mrr@10: bm25 0.765, dense 0.794, hybrid rrf 0.799; overall rrf best at 0.899; keyword saturated for both — corpus-fit lsa has no oov failure mode) |
| 02-retrieval-eval | 2026-08-25 | python | from-scratch okapi bm25 (lucene idf, k1 tf saturation, b length norm) vs sklearn-style tf-idf cosine (raw tf, smooth idf, l2 norm); evaluated with recall@1/recall@5/mrr@10 over a committed 40-doc / 38-query golden dataset, per-query head-to-head by reciprocal rank, plus a b=0 ablation isolating length normalization (mrr 0.917 tf-idf / 0.934 bm25 / 0.893 b=0); dataset includes engineered kitchen-sink distractor docs and deliberate vocabulary-mismatch queries to show where lexical retrieval fails |
| 01-structured-output | 2026-08-25 | python | layered JSON parse repair (fence strip, balanced-brace extraction, trailing-comma removal, python-literal fallback) + pydantic schema validation with a validation-error-feedback retry loop and hard-failure policy; benchmarked strict vs lenient vs full retry on 30 scripted-failure tickets (20.0% → 60.0% → 96.7%, 44 llm calls vs 30) |

Note on 06: two stranded branches had implemented backoff+jitter twice
(claude/stoic-albattani-mz3nch, 06-retry-backoff, callback discrete-event sim,
three scenarios; claude/stoic-albattani-wbddzz, 06-rate-limiting, async
virtual clock, pacing + retry-after + transient faults in one herd scenario).
06-rate-limiting was kept and landed: near-equal quality and test count, but
its clock drives real promise-based retry code, the shape production retry
code actually has, and it adds the client-side pacing comparison. The
06-retry-backoff twin was discarded, not merged, to keep one implementation
of the mechanism per language; its extra scenarios (outage recovery,
dead-service give-up) live on as an open thread.
Cleanup caveat: deleting the nine stale remote claude/* branches was
attempted and denied (403 on ref deletion; write access here is limited to
fast-forward pushes). They are all now either fully merged or superseded by
main and safe to delete by hand from the github branches page.

## FINDINGS

Open issues found by review, worst first. High = wrong results or wrong
claims, medium = robustness or consistency, low = performance wrong in kind.
Fixed items stay listed with their fix date so the history reads in one place.

- [fixed 2026-08-27] 05 — the field-availability table counted a field as
  available the moment its value *started*, not when it carried anything.
  the finding as first written named two fields; on checking it, only one is
  real. snapshots are taken once per `tool_args_delta`, and the fixture's
  fragment sizes ([4,9,2,6,13,3]) mean `query` is never observed as `""` — it
  is first seen holding `"bre"`, a genuine prefix of a string that only grows,
  which is exactly what a streaming UI renders. `filters` is the real one: it
  is first seen as `{}` at 60.5% and does not hold a filter until 63.8%, so
  the row said a dispatcher could read filters that werent there. the readme
  drew "a dispatcher can start validating it, at 44% of the stream" off the
  table and the root readme "tool-call fields readable at 44% of the stream";
  both now say what the columns mean. `runPipeline` records a second point per
  field — when the value first carries anything (non-empty string, container
  with an entry, any scalar), `null` if it never does — and the demo prints
  both. `filters` 60.5% → 63.8%; every other field's two columns coincide, and
  no other number in the project moved. the never-carries case has no instance
  in the fixture so it is pinned by a synthetic wire in the tests. no other
  project computes field availability, so nothing to port. found 2026-08-27,
  fixed 2026-08-27
- [low] 05 — the sse parser strips a byte order mark twice: `TextDecoder("utf-8")`
  already removes a leading bom (ignoreBOM defaults false), and `processLine`
  then strips another from the first line, so a stream opening with two boms
  loses both where the spec keeps the second. `test_strips_a_leading_bom` passes
  either way because it only ever sends one. the second strip is dead on every
  real stream. found 2026-08-27
- [medium] 03 — `stem` lets the plural strip fall through into the -ed strip, so
  "exceeds" loses its s to become "exceed" and then loses "ed" to become "exce",
  while "exceeded" stops at "exceed". both words are in dk-06, so the doc
  disagrees with itself on one term. no query uses either, so no measured number
  moves today. separate mechanism from the undouble fix below (suffix rules
  chaining, not the undouble guard), so it was not folded into that commit.
  found 2026-08-27
- [medium] 03 — the tokenizer regex is `[a-z0-9]+(?:[-_][a-z0-9]+)*`, ascii-only
  despite the re.UNICODE flag, so a non-ascii letter acts as a word boundary
  rather than a character: "naïve" splits into "na" + "ve" and "Ünicode" becomes
  "nicod". `test_non_ascii_does_not_crash` pins "café" → "caf" as if the
  truncation were wanted. 02 and 04 keep a unicode run whole (their own finding
  below), so the repo now has two different unicode behaviors and 03s readme
  mentions neither. corpus is english, no number moves. found 2026-08-27
- [low] 03 — when no query term is known, every score is 0 and `np.argsort`
  stable-sorts into corpus order, so the retriever still returns a full ranking
  headed by whatever doc sits at index 0 (git-01) and the metrics score it as a
  real retrieval. the score contract is tested (`test_oov_query_scores_zero_
  everywhere` in both retrievers), the ranking one is not. no committed query
  is affected — all 40 carry at least one known term. found 2026-08-27
- [low] 02 — the readme quotes the headline disagreement as "expire old entries
  from an in-memory cache"; the committed query is "expire old entries from an
  in-memory cache automatically". same for "the raw 0.017 gap", which `main.py`
  prints as +0.018 — both are the same number rounded twice, but the readme
  should say what the entry point says. found 2026-08-26
- [low] 02 — `print_significance` decides "excludes zero" on `ci.lo > 0` while
  printing `ci.lo` to 3 decimals, so a lower bound of 0.0004 would print
  "[+0.000, ...] — interval excludes zero" and contradict itself on screen.
  not triggered by the committed data, where the bound is exactly 0.0.
  found 2026-08-26
- [low] 02, 04 — `tokenize` runs `[^\W_]+` over unicode, so a whole cjk sentence
  becomes one token and only matches on exact whole-run equality. no measured
  number moves (the corpus is english) and `test_unicode_text_survives` pins the
  behavior as if it were wanted — 04 measures the same cost honestly, 02 doesnt
  mention it. found 2026-08-26
- [fixed 2026-08-27] 05 — the backpressure demo derived peak buffered memory as
  `queue.size * 24`, where 24 is the *maximum* chunk size rather than the size
  of the chunks actually held. chunk sizes are uniform in 1..24, so the figure
  came out at nearly twice the truth and the demo printed 10032 bytes buffered
  out of a 5185-byte stream — more than the whole stream, which is the tell.
  the readme repeated it as "419 chunks (~10KB)" and reasoned "10KB doesnt hurt
  anyone" off it. `AsyncQueue` takes an optional `sizeOf` now and keeps a byte
  high-water mark from the real item sizes; the demo reads that instead of
  estimating. unbounded peak 10032 → 5169 bytes, bounded(8) 192 → 149. chunk
  counts (419 / 8), stall and wall times unchanged, and the O(1)-vs-O(stream)
  conclusion is unchanged — only the size of the number backing it. no other
  project buffers byte chunks, so nothing to port. found and fixed 2026-08-27
- [fixed 2026-08-27] 04 — the open questions claimed mixed-domain training "won
  on code without hurting prose", but that reads the mixed@1659 column the
  readme itself calls confounded (413 extra vocab slots). the matched-vocab
  control says the opposite: held at 1246 vocab, prose goes 2.94 → 2.80
  bytes/token, 4.9% more tokens, to buy 41.8% fewer on code. crowding is
  already visible at two domains. run_benchmark now prints the trade in both
  directions and the readme quotes it. no core algorithm number moved — the
  three-column table was already correct, only the takeaway drawn from it was
  wrong. found and fixed 2026-08-27
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
- [fixed 2026-08-27] 03 — `_undouble` stripped the final letter of any doubled
  consonant left behind by an -ing/-ed strip, l, s and z included. those
  doublings belong to the base word, not the suffix, so "killed" stemmed to
  "kil" while "kill" stemmed to "kill" and a query term stopped matching its own
  document term — same for install/installed, call/calling, fills/filling, and
  pass/passed. the readme claimed the stemmer "maps morphological variants onto
  one form" while three such families in the committed corpus were split. l, s
  and z are excluded from the undouble now, the exclusion porter's step 1b makes
  for this exact reason; stopped → stop and running → run are unaffected and
  still pinned. paraphrase dense mrr@10 0.794 → 0.793 (the jwt doc for p14 moves
  rank 8 → 9), hybrid weighted a=0.5 0.889 → 0.887 overall and 0.779 → 0.774 on
  paraphrase; bm25, dense overall, rrf and every keyword number unchanged, best
  alpha still 0.2. no other project has a stemmer. found and fixed 2026-08-27
- [fixed 2026-08-26] 03 — `reciprocal_rank` took no rank cutoff while 02 reports
  mrr@10, so the same metric name meant two things in two folders. 03 ranks the
  whole 100-doc corpus, so an uncapped mrr had no failure mode at all: the one
  query bm25 only answered at rank 12 booked 0.083 instead of 0. cutoff is a
  required argument now, `MRR_K = 10` at every call site, column reads mrr@10.
  bm25 0.885 → 0.882, rrf 0.902 → 0.899, paraphrase bm25 0.769 → 0.765,
  paraphrase rrf 0.803 → 0.799, alpha sweep best still 0.2. no ordering changed
- [fixed 2026-08-25] 01 — `extract_balanced_object` tracked only `"` as a string
  delimiter while also feeding the `python_literal` layer, so a python-dict
  reply with an unmatched `{` or `}` inside a value had its depth count broken,
  got truncated, and was thrown away — burning a retry on output that layer
  already handles. both quote styles delimit strings now. no measured numbers
  moved: no summary in the committed dataset carries a brace

## REVIEWED

| project | last review |
|---|---|
| 05-token-streaming | 2026-08-27 |
| 03-hybrid-search | 2026-08-27 |
| 04-bpe-tokenizer | 2026-08-27 |
| 02-retrieval-eval | 2026-08-26 |
| 01-structured-output | 2026-08-25 |

Note on the first pass: every project in the repo was committed on 2026-08-25,
so the "let it settle for 24 hours" rule would have skipped all four. Reviewed
the oldest instead (01, committed 17:44 UTC) rather than run a no-op. Same on
2026-08-26 — everything was still inside 24 hours, so the oldest unreviewed
project went first (02, committed 18:10 UTC).

02 came back clean on its own code: tf-idf matches sklearn's TfidfVectorizer to
1.1e-16 on every committed query, bm25 matches the lucene formula term by term,
reciprocal rank is 1-indexed and recall@k slices k, everything is seeded and
reruns identically, and all 12 readme numbers match what `main.py` prints today.
The finding that came out of it was the cross-project one, in 03.

04 came back clean on its algorithm: the from-scratch bpe reproduces an
independent minbpe-style reference term for term — identical 990 merges on the
prose corpus, 577 on code, identical encodings on all three heldout files — and
the trainer/encoder agree, all 4 tricky-string classes round-trip, output is
deterministic across PYTHONHASHSEED, and all 16 readme numbers match
`run_benchmark.py`. edge cases hold (empty/whitespace corpora, unseen bytes,
partial-utf8 decode, vocab-below-256 rejected). the finding was a claim the
run's own control column already refuted — the domain-crowding takeaway, now
fixed.

05 came back clean on both parsers and dirty on one measurement. the partial-
json scanner survived a differential fuzz over every prefix of 400 generated
documents (nested objects/arrays, escapes, unicode, emoji, exponents): no
prefix of a valid document was ever rejected, every snapshot was a genuine
prefix of the final value (keys only from the real document and never
disappearing, settled keys never changing, strings always prefixes), and every
full document came back `complete` except bare top-level numbers and literals,
which are `partial` on purpose. the sse parser is self-consistent under 300
random chunkings plus byte-by-byte, handles cr-on-a-boundary, and matches the
whatwg model on multi-line data, one-space stripping, empty-data suppression,
nul-in-id and non-numeric retry; the one divergence is a double bom strip,
listed low. the queue is fifo, honours capacity, and wakes waiting consumers on
close. the defect was in what the backpressure demo *reported*: peak buffered
memory computed as chunk count times the largest possible chunk, fixed above.
the field-availability metric under measurement 2 is the other side of that
coin and was raised as a second high finding, then fixed the same day — the
timing columns, which are wall clock and move a few percent per run, are
labelled as such in the readme now rather than quoted as fixed measurements.

fix run on the availability finding turned up one thing worth recording as a
habit: the finding named `query` and `filters` as both first-seen-empty, and
`query` isnt. snapshot granularity is one per `tool_args_delta` event, not per
byte, so a state the byte stream passes through can be invisible to the
measurement that samples it. reviewing means checking the finding against a
run, not just against the source — half a finding still ships half a fix.

03 came back clean on retrieval and clean on measurement: bm25 matches the
lucene formula term by term and dedupes repeated query terms like 02, the lsa
side fits on the corpus alone with nothing from the query set touching the
vectorizer or the svd, rrf sums 1/(60+rank) on 1-indexed ranks, weighted fusion
min-maxes both arrays before blending, recall@k slices k, reciprocal_rank is
1-indexed and cut at 10, output is byte-identical across reruns and across
PYTHONHASHSEED, and every readme number matches `main.py`. the alpha sweep does
read its best value off the same 40 queries it tunes on, which is the classic
misleading-measurement shape — but the readme already calls it "reading tea
leaves" and refuses to name a production constant, so it is disclosed, not
claimed. the defect was one layer down in the shared tokenizer: the stemmer
split words from their own inflections, fixed above. two smaller tokenizer
findings came out of the same read and are listed open.

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
- reciprocal rank / mrr@k (02, 03; the rank cutoff is a required argument in both and both run it at k=10, with a test in each project holding that a hit past the cutoff scores 0)
- per-query head-to-head comparison by reciprocal rank (02)
- golden dataset construction: engineered kitchen-sink distractors and vocabulary-mismatch queries (02), keyword vs paraphrase category split (03)
- regex word tokenizer with stopword removal, naive suffix stemmer, hyphen/underscore compounds kept whole and split (03)
- lsa dense retrieval: tf-idf term-doc matrix → seeded truncated svd (03)
- reciprocal rank fusion (03)
- weighted score fusion with min-max normalization and an alpha sweep (03)
- linearly interpolated percentile (02; sanctioned typescript port in 06 — same interpolation, pinned by tests to the same known values)
- percentile bootstrap confidence interval on a mean (02)
- paired bootstrap over per-query differences with a direction-stability fraction (02)
- byte-level bpe: weighted pair counting, lexicographic tie-break on frequency ties, rank-ordered merge application, byte fallback (04)
- regex pretokenization with leading-space attachment, ` ?\S+|\s+` (04)
- merge-prefix vocab truncation: train once at max vocab, smaller vocabs are prefixes of the merge list (04)
- closed-vocabulary word tokenizer: top-n types by frequency plus unk, oov-rate measurement (04)
- character tokenizer with unseen-character reporting (04)
- compression metrics: bytes per token, tokens per character (04)
- token cost accounting at a parameterized price per million tokens (04)
- incremental sse parsing over byte chunks: line reassembly across boundaries, streaming utf-8 decode, event field state machine (05, typescript)
- partial-json prefix parsing: container-stack scan, safe-index truncation, unambiguous token completion (05, typescript)
- bounded async queue with promise-blocking push backpressure and high-water/stall stats (05, typescript; capacity is in items, and an optional `sizeOf` adds a second high-water mark in the item's own unit — bytes for byte chunks — so buffered memory is summed, never estimated from a count)
- seeded prng (mulberry32) byte-level chunk-boundary fuzzing (05, typescript; 06 imports the prng from 05's folder rather than duplicating it)
- field-availability metric: fraction of stream bytes received when a field first parses (05, typescript)
- virtual-time clock: deterministic (time, schedule-order) timer firing, deadlock detection, run-until-settled driver (06, typescript)
- continuous-refill token bucket: lazy elapsed-time refill, burst cap, exact next-token wait (06, typescript)
- backoff policies: fixed, capped exponential, full jitter, equal jitter, decorrelated jitter (06, typescript)
- bounded retry loop with retry-after compliance and hard failure after max retries (06, typescript)
- client-side pacing limiter: token bucket whose acquire waits instead of failing (06, typescript)
- retry-collision metric: max retries arriving at the same virtual instant (06, typescript)
- word n-gram shingling with nfkc/casefold normalization and short-text single-shingle fallback (07)
- exact jaccard similarity over shingle sets, empty-empty defined as 1.0 (07)
- minhash signatures: seeded affine hashes mod the mersenne prime 2^61-1, prefix-truncatable, empty-set sentinel (07)
- banded lsh candidate generation with collision s-curve 1-(1-s^r)^b and halfway-threshold placement (07)
- 64-bit simhash fingerprint with per-bit shingle voting + hamming distance (07)
- seeded document mutation family (typos, word drops, sentence shuffle, truncation, case/whitespace noise) with provenance-based duplicate labels (07)
- pair-level precision/recall/f1 against labeled duplicate pairs (07)
- agent tool loop with hard edges: model-call budget, per-intent validation-feedback cap, identical-invalid-call loop guard (08, typescript)
- zod strict-object tool schemas with path-labeled issue feedback (08, typescript; the validation-error feedback retry idea is 01's in python — 08 applies it per tool call inside a multi-step loop, not to one structured reply)
- scripted reactive tool-calling model: authored intents, flaws, correction rules, pure function of the visible history (08, typescript)
- clean-twin cost delta: a flawed task re-run with flaws stripped to price the flaw class (08, typescript)
- canonical key-sorted json serialization for tool-call identity (08, typescript)
- token estimate proxy at ~4 chars/token with input/output pricing over full-history replay (08, typescript; 04's python accounting prices real bpe tokens, this prices an estimate)
- fifo counting semaphore with direct permit handoff and a double-release guard (09, typescript)
- bounded-parallelism map over a semaphore: fail-fast and per-item settled variants, input-order results (09, typescript)
- micro-batcher: size/deadline dual flush trigger, batch-identity check against stale uncancellable timers, per-item promise routing (09, typescript)
- simulated llm batch endpoint: per-item latency slope, fifo admission cap, per-call token overhead plus per-item tokens, whole-batch validation rejection (09, typescript)
- prompt-overhead amortization: cost per item as a function of batch size (09, typescript)
- seeded exponential inter-arrival process (09, typescript)
- poisoned-batch recovery strategies: fail-all, capped retry-whole, one-by-one, binary-search isolation (09, typescript)
- regex sentence splitter with character spans: terminator-run boundaries, abbreviation guard, str.isupper next-sentence check so accented scripts split (10)
- fixed word-window chunking with optional overlap, chunks as exact [start, end) doc substrings (10)
- greedy sentence-packing chunker: whole sentences up to a word budget, oversized sentence becomes its own chunk (10)
- exact answer-containment relevance: chunk relevant iff the verbatim gold sentence survives inside it (10)
- boundary split-rate metric and answer best-coverage (char-span overlap of answer with its best chunk) (10)
- context-cost-at-k: words in the top k retrieved chunks as a prompt-size proxy (10)
- authored corpus with verbatim-unique answer sentences, validated once-per-corpus at load (10)
- simulated prefix cache with provider semantics: longest-cached-prefix hit, delta-billed writes, ttl refresh-on-read, min cacheable prefix, breakpoint cap, 20-block lookback (11, typescript)
- prompt-cache pricing model: per-ttl write multipliers and read discount over parameterized base prices (11, typescript; 04's python accounting prices raw tokens, 08's prices an estimate, this one prices cache-billed token classes)
- cache breakpoint placement strategies: static prefix, incremental tail, lookback-spaced intermediate markers (11, typescript)
- seeded phrase-bank conversation generator: interleaved multi-conversation arrival stream, volatile-header variant, tool-heavy turns, unique one-shot requests (11, typescript)
- cache traffic metrics: token-weighted hit rate, cost ratio vs no-caching baseline, per-request write series (11, typescript)

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
- 04: crowding is already measurable at two domains (prose 2.94 → 2.80 at matched vocab to buy 41.8% on code, fixed 2026-08-27) — the open shape is the curve as domains multiply, and whether there is a budget past which a new domain stops paying for itself
- 04: script cost is measured per line and the emoji line is diluted by the english around it — a per-codepoint-class breakdown would price each script honestly

- 05: queue capacity is counted in chunks — a byte-budgeted queue is what a real memory ceiling wants, and chunk sizes varying 1000x would break the chunk-count story
- 05: partial-json snapshots recompute from the full accumulated text every fragment, O(n^2) over the stream — a resumable scanner carrying state between fragments is the fix, the crossover size is unmeasured
- 05: the sse parser buffers an unbounded line if the stream never sends a terminator — needs a cap and a deliberate failure mode
- 05: the stream is scripted and the chunker is uniform 1..24 bytes — real networks burst; replaying a captured real provider stream (timings included) would make the ttft and availability numbers mean something outside the fixture

- 06: the herd is one-shot at t=0 — a poisson arrival process with a congestion spike in the middle would test whether the strategy ordering survives steady-state traffic
- 06: full jitter and decorrelated fail 2 and 7 of 200 requests where equal jitter fails 0 — is the delay floor the real variable? a floor sweep (0%, 25%, 50% of exp) at fixed retry budget would isolate it
- 06: retry-after re-synchronizes clients (collide 12) because the hint is deterministic — does a server-jittered hint keep the makespan win without the collisions?
- 06: pacing is measured at exactly the server rate — a rate sweep (80%..120% of server rate) would find the throughput/429 knee, and adaptive pacing (aimd on 429s) is the real-world answer when the server rate is unknown
- 06: 503 retries bypass the pacing bucket by design and cause every leftover 429 — routing retries through the pacer (and measuring the makespan cost of that fairness) is a one-line change with a real trade-off attached
- 06: the virtual clock fires timers one at a time with a full continuation flush between — at what simulated scale does that become the bottleneck, and what does batching same-instant timers buy?
- 06: the discarded 06-retry-backoff twin measured two failure shapes this project doesnt — outage recovery against retry-after hints (exact vs jittered) and retry pressure on a dead service where every client must give up — worth re-measuring on 06's clock and server

- 07: the s-curve was placed knowing the duplicate floor (0.280), which real pipelines never know — what does adaptive band/row selection from sampled candidate similarities look like?
- 07: multi-probe lsh claims recall without more tables — how much of the mistuned banding's 0.086 recall gap does probing buy back, at what probe cost?
- 07: simhash used unit weights per shingle; the original paper weights by importance — does idf weighting pull the overlapping dup/non-dup hamming tails apart enough to close the f1 gap?
- 07: band buckets are exact tuples in dicts — at scale the tables are the memory problem, and hot buckets from boilerplate shingles blow up candidate counts; bucket-size distributions are unmeasured here
- 07: exact-jaccard verification reuses shingle sets already in memory — in a store where fetching originals costs io, when is a k=512 signature verdict cheaper than the fetch, and at what false-verdict rate?

- 08: per-flaw rates and correction curves are authored here — what does a real model actually do on these same tool schemas, and does the 1-round recovery assumption survive contact?
- 08: the loop guard keys on exact (name, canonical args) identity, so a stubborn model that mutates its broken call walks past it — would keying on the zod issue signature (paths and codes, not values) catch drifting-but-equivalent failures without new false positives?
- 08: full-history replay dominates the stubborn burn — with cached input priced at a tenth of fresh, how much of the 80.9% guard saving survives prompt caching?
- 08: the scripted model corrects on any feedback message — real models correct better on some phrasings; an error-message-quality ablation needs a real model in the loop
- 08: tool results are always well-formed here — valid args but garbage results the model then reasons over is the unmeasured dual failure mode, and probably the costlier one

- 09: the right micro-batch wait budget is a function of the arrival rate — what does a batcher that estimates arrival density and tunes its own deadline recover vs the best fixed setting?
- 09: real batch apis sometimes name the failing index in the error body — how much of bisect's 11-vs-33-call advantage survives when a probe can be replaced by parsing the error?
- 09: poison here is deterministic — flaky items (fail 30% of the time) break bisect's passing-half-is-clean assumption; at what flake rate does bisect stop beating one-by-one entirely?
- 09: composing with 06's 429-ing server would price batching as a rate-limit dodge (one call of 32 items costs one admission token) — unmeasured
- 09: past the server cap, observed latency crosses fixed client timeouts and triggers retries, which adds load — wiring 06's retry policies into this queueing model would show whether that loop converges or storms

- 10: answers here are single sentences, so sentence packing cannot split one by construction — at what answer length (facts spanning 2-3 sentences) does its advantage blunt, and does overlap-on-sentences beat overlap-on-words there?
- 10: the containment metric scores a 71%-coverage chunk as a total miss — how often does a model actually answer correctly from a partial chunk? needs a model in the loop to turn split% from a proxy into a cost
- 10: is hit@5 0.850 (sentence-80) vs 0.775 (fixed-80/ov-20) a real gap on 40 queries? 02's paired bootstrap machinery applies directly and was not run
- 10: semantic chunking (split on topic shift, not word count) is the fashionable comparison and needs an embedder — same missing piece as 03's pretrained-embedder thread

- 11: spaced-15 spends a third of the 4 breakpoint slots fixing the lookback miss — what is the optimal placement policy when turn block-counts vary, and can it be computed online from observed turn shape?
- 11: concurrent identical requests all miss until the first response streams; the documented fix (fire one, await first token, fire the rest) trades latency for duplicate writes — the crossover as a function of fan-out width is unmeasured
- 11: ttl is measured request-start to request-start, so generation time silently shrinks the window — at what generation-time distribution does a nominal 5m ttl behave like 1m, and does that flip the sweep verdict?
- 11: the volatile header sat at block 1 and killed 100% of hits — a volatile block at position k should only kill the cache past k; the cost-of-volatility curve by position is unmeasured
- 11: cache hits change latency as well as cost (cached prefixes skip prefill) — pricing that needs a latency model per cached vs uncached token, which the simulator doesnt have

## BLOCKED

(empty)
