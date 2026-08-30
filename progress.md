# progress

State of the repo: what's finished, which mechanisms already exist anywhere
in it, and the open questions each project left behind. New work checks
MECHANISMS first so nothing gets a second, disagreeing implementation, and
OPEN THREADS for the questions worth answering next.

## COMPLETED

| project | date | language | mechanism |
|---|---|---|---|
| 08-agent-tool-loop, drift extension | 2026-08-30 | typescript | drift study answering 08's guard-key thread on the unchanged loop and tools: per-feedback-round drifting flawed-call scripts (flawDrift sequence, clamped at the last variant, still a pure function of the visible history) + zod issue-signature guard key (tool name + sorted issue path:code pairs; values, messages, and unrecognized key names excluded, unknown tools keyed by name) beside the exact (name, canonical args) key, with the trip limit made a policy knob + authored 10-task drift suite (value drift, extra-key-name drift, alternating/rotating shape drift, same-signature slow correctors, progressive correctors whose signature shrinks) + corrector-kill accounting (tasks feedback completes that a guard kills) + signature-guard limit sweep 2..6 + like-for-like check on the original 25 tasks at identical seeds; measured — the exact guard saves 0.0% against drifting stubborn models (never fires once; 80.9% against verbatim repeats was the failure being dumb, not the guard being clever), the signature key gets 61.6% of the stubborn burn back at limit 3 but kills both slow correctors (completion 4/10 → 2/10), rotating three broken shapes walks past both keys, and the limit is the real knob: limit 4 spares every corrector while still capping stubborn burn at 30 model calls vs feedback's 42 (44.2% of stubborn tokens saved, zero completion loss), with the signature key byte-identical to exact on all 25 original tasks |
| 02-retrieval-eval, inverted-index extension | 2026-08-30 | python | inverted index answering 02's full-scan scaling thread: posting lists term -> [(doc index, tf)] in ascending doc order with term-at-a-time accumulation ordered exactly like the flat scan so every score is bit-identical (tests assert result-list equality on exact floats; 38/38 golden queries at full depth, 150/150 synthetic across strata) + heap top-k selection over candidate accumulators with (-score, doc id) ordering + exact search work accounting (postings touched, candidates, terms matched, flat work priced as matched terms x corpus size) + seeded zipf synthetic corpus/query generator (vocab 20000, exponent 1.1, query strata typical / common-heavy / rare-only) + corpus-size sweep and stratum harness with wall clock and work counts; measured — the flat scan falls over linearly and smoothly (0.910ms/query at 1k docs to 65.229ms at 32k, ~2.0s projected at 1M by the slope), and the inverted index is a constant-factor win on zipf traffic, not a complexity-class one: postings touched grow linearly too (1398 to 44926 per query), the touch ratio sits flat at 2.8x and wall clock at 3-6x, because a typical query nearly always carries a common term (rank-1 df is 99.9% of docs, a typical query scores 26963 candidates of 32000, the head term owns 64.9% of postings touched) — while rare-only queries get the imagined win (77 postings vs a full corpus scan per matched term, 0.086ms vs 32.924ms, 382.6x) since inverted query cost is the sum of the terms' document frequencies, not corpus size; the measured argument that production search is posting lists plus stopword handling and wand-style pruning |
| 06-rate-limiting, outage extension | 2026-08-30 | typescript | outage and hint-jitter studies answering 06's two open threads on its unchanged clock and server: simulated hard-outage window [start, end) with instant pre-admission 503s that never drain admission tokens, optionally advertising time-to-recovery, endMs=Infinity as the dead service (advertising then refused at construction) + server-side additive uniform Retry-After jitter from a dedicated rng so enabling it leaves the seeded latency/fault stream bit-identical (main table reproduced exactly) + retry loop extended to honor Retry-After on 503 as well as 429 + outage scenario runner (waste during outage, recovery spike per 100ms anchored at the recovery instant, drain time, give-up latency percentiles, peak attempts/s) + give-up cliff grid over outage duration x policy; measured — jittered hints kill retry-after's residual re-synchronization at every width (collide 12→2 on the steady herd, worst 14 vs 3 across 5 seeds) at no makespan cost that survives the seed sweep (mean 14.21s jittered vs 14.46s exact inside a 9.47-15.73s exact-hint spread, exposing the main table's 9.47s makespan as the best of 5 seeds, ordering right, margin seed luck), a hard outage flips jitter from cure to liability at a fixed retry budget (10s outage: no-jitter 100% vs full jitter 67.5% because short draws burn the budget early, equal jitter's floor holds 100%; no guessing schedule outlives the 22.7s cumulative-backoff cliff), the 20s no-jitter herd survives the outage then loses exactly half to its own 40-wide recovery wall against burst 20, an exact recovery hint recreates the herd it prevented (54/100ms spike, 53 429s) where a 1s-jittered hint spreads it (7/100ms, 2 429s, 82 vs 133 total attempts) and still drains faster (1.89s vs 2.17s), and the dead service prices the missing circuit breaker: every retrying policy burns exactly 9 attempts per request (1080 total), backoff only chooses the shape (fixed-100ms 440 att/s for 2.40s vs exp-no-jitter 160/s for 68.10s) with 11.33-22.70s p50 caller hangs and no learning between sequential requests |
| 05-token-streaming, resumable extension | 2026-08-29 | typescript | resumable partial-json scanner answering 05's O(n^2) open thread: the same prefix semantics as parsePartialJson but with scan state carried between push calls (container stack holding references into the value tree under construction, string tokens decoded incrementally with an escape-sequence buffer so split \uXXXX and surrogate pairs survive fragment boundaries, number/literal tokens in their own small text buffers, the accumulated text never retained at all, poison-once handling so invalid input never rescans) + a two-price read contract: view() returns the live tree in O(1) beyond dangling-token completion (the completed dangling value is spliced in with a recorded undo reverted on the next call) while snapshot() deep-copies via structuredClone at O(tree) + seeded tool-call-shaped document generator with escapes and non-ascii + replay harness pricing one-materialization-per-fragment across baseline/view/snapshot modes with chars-scanned work accounting; equivalence pinned prefix-by-prefix, per-boundary under seeded chunkings, and through split escapes, statuses included; measured, one value read after every fragment on seeded 1..24-char fragments: no crossover exists, the resumable view wins at every size (0.09ms vs 0.03ms at 266 chars, 3.4x; 2457.96ms vs 3.71ms at 65619 chars, 662.5x) because the baseline feeds 172521764 chars through its scanner at 64KB (2629.1x the document, then roughly the same again in JSON.parse of the repaired text) where the resumable scanner reads each char once, a 1MB stream replays in 69.1ms over 84070 fragments (~0.8us/fragment) against a projected ~629.2s for the baseline by the n^2 law, and the snapshot mode is the honest asterisk: deep copy per fragment is O(tree) again, 669.45ms at 64KB, quadratic in shape, so the win lives in the view contract |
| 25-query-rewriting | 2026-08-29 | python | query rewriting / hyde measured against the raw query over one unchanged bm25 index: scripted hyde stand-in (40 authored hypothetical answers written from the question text alone, per-query sha256 unit draws making hallucination sets nested across rates, the wrong answer fixed as the next sorted query id so sweeping the rate changes only whether the failure fires) + append vs replace search-string modes + prf one-hop expansion via 23's bridge-term extractor with unmatchable-query fallback + generic-filler control arm + expansion-size accounting (distinct search terms added beyond the raw query) + delta-rr split by expansion-source relevance; imports 02's bm25/tokenizer/metrics/paired bootstrap and 23's extractor, data is 03's corpus and golden queries, no new corpus; measured — honest hyde-append lifts mrr@10 0.830→0.983 (paraphrase 0.736→0.967, paired bootstrap +0.153 [+0.046, +0.270] excluding zero) and rescues the oov acronym query "GIL" from 0 to a perfect hit, generic fluent filler is negative value at 0.560 (-0.270, p_le_zero 1.0000) because every added term votes for whatever docs contain it, prf is a near no-op (+0.008, ci lower bound +0.000): 32 of 40 first-search top docs are already gold and their expansions move mean rr exactly +0.000, while the one rescuable query returns no results to extract from — and the hallucination sweep prices the anchor: at a 10% wrong-answer rate replace-mode already loses to the raw query (0.822 vs 0.830) while append holds 0.866, and at 100% append keeps 0.367 on query-term votes where replace craters to 0.057 |
| 24-extraction-metrics | 2026-08-29 | typescript | json leaf flattening with generic (index-collapsed) paths + field-level extraction scoring (every gold leaf correct/wrong/missing, every predicted leaf correct/wrong/spurious, precision over predicted leaves, recall over gold) + value-normalization ladder L0-L3 (strict, nfkc/casefold/whitespace fold, currency/thousands numeric parse with tolerance, multi-format date to iso refusing ambiguous slash dates) + greedy order-insensitive array alignment scored by per-pair field f1 with deterministic tie-break + per-generic-path tally tables and macro f1 over gold paths + strict deep-equal exact-match accuracy + seeded structured-record flaw family (format drift, leaf dropper, hallucinator, shuffler, lazy truncation, typed corruptor, single-field bungler); imports 05's rng; measured on 12 authored invoices, 224 gold leaves — exact match scores format-drift, tax-bungler, and corruptor identically 0.000 while semantic field F1 reads 1.000/0.946/0.728, the ladder rescues format drift stepwise 0.219→0.397→0.946→1.000 and never moves the corruptor (0.728 flat, the safety check that no layer forgives real errors), alignment recovers the shuffler 0.647→1.000 with delta 0.000 on every other extractor, micro 0.946 hides a 0.000 totals.tax row only the per-path table names, and macro-over-gold-paths is blind to hallucinated structure (hallucinator macro 0.947 above its own micro 0.799 because invented paths have no gold row) |
| 23-multi-hop-retrieval | 2026-08-29 | python | iterative two-hop retrieval (retrieve, extract bridge terms from the top doc, requery, round-robin merge with dedup) + tf*idf novel-term bridge extraction with question-term exclusion and deterministic (-score, term) tie-break + oracle-bridge ablation splitting extraction failure from hop-2 ranking failure + append vs focus hop-2 query modes + three-bucket hop-1 drift accounting (gold / answer-leak / true drift) + pair@5 both-gold-docs metric; imports 02's bm25/tokenizer/metrics/paired bootstrap; authored 28-doc two-docs-per-service ops corpus (capability doc and infra doc joined only by a service name) with 24 two-hop queries, 8 single-hop blind controls, and trap distractors; measured — answer recall@5 0.667 single vs 0.958 append and 1.000 focus at exactly 2.00 searches per query, paired bootstrap mrr diff +0.080 [+0.043, +0.119] excluding zero, bridge coverage 0.958, focus beats append because question terms re-admit distractors, the one drift firing was a df=1 vocabulary-island echo the interleave dedups away, recall@1 pinned at 0.083 for every system including oracle by the hop1-first merge, controls undamaged at 2x cost |
| 22-rag-vertical-slice | 2026-08-29 | typescript | vertical rag slice as one live service: node http POST /ask endpoint with strict validation (400 empty/non-string question or bad k, 413 past 500 question chars or 16 KB body, 405/404, unicode fine) + doc-level retrieval over 18's hashed word-feature cosine (one vector per doc, score-desc id-asc ties, all-zero rankings returned and the reader left to refuse) + scripted extractive reader (14's splitter and stopwords, best sentence by fraction of question content words, 0.35 refusal floor, verbatim quote or fixed refusal) + sse server-side event serialization and drain-aware socket writes with 05's bounded AsyncQueue between generation and delivery (wire format roundtrip-pinned against 05's parser over 30 seeded chunkings) + per-request token/cost log via 08's estimator and pricing with a system/question/context split + live-endpoint eval hook over real http (containment against 10's 40 golden queries, misses attributed retrieval-miss vs wrong-sentence vs refusal, keyword/paraphrase split, k sweep) + deterministic first-token byte fraction (client re-encodes parsed events with the server's own serializer, chunk-summed and wire-summed bytes asserted equal) + slow-client backpressure harness (every write blocks one macrotask); data is 10's corpus, no new dataset; measured — hit@k climbs 0.650/0.800/0.900/0.950 across k 1/2/3/5 while answer accuracy crawls 0.350/0.400/0.450/0.475 because extraction among retrieved-gold sits at 0.500 and slips as every extra doc adds distractor sentences, k=1 -> 3 buys 0.100 accuracy for 2.85x input tokens ($0.1228 -> $0.3239 per 40 questions), keyword 0.700 vs paraphrase 0.200 at k=3 with the same lexical machinery failing on both sides of the pipeline, answered-without-gold is 0 in every row (the floor turns misses into refusals, never confident wrong-doc quotes), context is 2318 of 2367 traced input tokens, the first token completes at a mean 23.3% of response bytes, and a 466-piece worst-case dump buffers 465 events / 17668 bytes unbounded vs 8 / 322 bounded(8) with 457 paced pushes, while all 162 fast-client requests hold queue high-water at 0 |
| 21-vector-store-persistence | 2026-08-29 | python | vector store persistence and mutation over 13's unchanged hnsw (MutableHnswIndex subclasses it, search runs 13's code path): binary file format with length-prefixed sections (json header, raw float64 vectors, u32-framed link lists) and a sha256 trailer verified before any parsing, atomic temp-write-fsync-rename saves + full-state serialization including the rng state (level draws consume it, so growth after load equals growth without a save) + corruption refusal (bit flips, truncation, bad magic, bad version, self-consistent-but-invalid state) + tombstone deletes with over-fetch-and-filter live search + batch hard unlink with one-pass graph-wide edge stripping and entry reassignment + compaction rebuild with id remapping + exact-over-live ground truth + live-from-entry reachability + hub-targeted removal by descending layer-0 degree; measured — a 2000-vector store is 738027 bytes (links are 44% on top of the 512000-byte vectors), roundtrip search identity 150/150 with link-identical continued growth while a reset rng diverges the graph on 12 of 100 new nodes' levels, incremental insert is bit-identical to fresh build at the same order (150/150) and costs 8500499 cumulative dists vs 26299226 rebuild-per-batch (3.09x) with insertion-order recall spread only 0.993-1.000 over 5 shuffles, tombstones hold recall at 0.997+ with zero short results even 70% dead but freeze cost at 304.9 dists/query where a compacted store pays 212.7-291.9 (waste 1.04x-1.43x, break-even 349558 queries at 10% dead collapsing to 18770 at 70%), and hard-unlinking 30% of nodes (even hub-first) leaves the heuristic-built graph at 0.994+ recall and full reachability while the same hub attack on a naive M-closest build collapses reachability to 0.638 after 100 removals and recall to 0.703, the build-time edge-diversity heuristic re-read as delete tolerance |
| 20-guardrails | 2026-08-28 | typescript | input/output llm guardrails measured for what each check buys and where it goes blind: rule-based pii span detection (regex candidates behind validators, exact [start,end) spans) with a luhn checksum gating card candidates by brand prefix, an empirical shannon-entropy gate separating high-entropy secrets from placeholders, known-secret-prefix rules, dash-formatted ssn field validation, formatted-phone-only scope, ipv4 octet bounds + greedy earliest/longest/priority overlap resolution + typed-placeholder redaction (stable per value) + de-obfuscation normalization (nfkc, zero-width strip, cyrillic/greek homoglyph fold, in-word leetspeak fold, letter-spacing collapse) + weighted-rule prompt-injection scoring (override/exfiltration/hijack/smuggling/encoding rules, distinct-weight sum) with base64 decode-and-rescan + exact mann-whitney roc-auc (half-credit ties) and threshold sweep + a layered pipeline (input score gate -> scripted canary-carrying model -> canary substring check + output pii redaction) + authored 26-message/31-span pii corpus with luhn-fail and low-entropy hard negatives, and a 14-attack/12-benign prompt set with per-attack scripted compliance/leak-style labels; measured — pii detection P/R/F1 1.000/1.000/1.000 on the authored corpus where dropping luhn or the entropy gate each costs one false positive (P 1.000 -> 0.969), injection roc-auc 0.729 raw text -> 0.890 with de-obfuscation entirely from the four obfuscation categories (spacing/leet/homoglyph/base64) going 0% -> 100% detection while plain-text categories are identical in both, one benign message false-flags in both configs on jailbreak-vocabulary collision, and the pipeline's undetected leaks drop 2 -> 1 with the residual being the paraphrased system-prompt leak that carries no canary token, the documented limit of string-level output filtering |
| 19-eval-regression | 2026-08-28 | python | eval harness with regression gating: templated 6-category golden set (240 committed items, per-item authored distractor and difficulty offset, committed file pinned equal to the builder output by a test) + scripted bernoulli model versions over per-category skill tables (baseline, aggregate-masked slice regression, 3-point uniform drift, uniform improvement; outcomes deterministic per (version, item id, eval seed) via sha256-derived rngs) + persisted run records with a dataset sha256 fingerprint and load-time self-consistency recompute (tampered or truncated artifacts rejected, fingerprint mismatch refuses to compare) + paired run comparison (flip table, per-category deltas, 02's paired bootstrap imported for aggregate and per-slice intervals) + gate policies (naive threshold, aggregate ci, per-slice ci, combined) + gate error rates over 50 seed pairs per scenario against known ground truth + ci-gate power curve over template-generated golden sets; measured — same-model reruns swing up to 7 points on 240 items so a 1-point threshold gate false-alarms 40.0% while the ci gate holds 2.0%, the aggregate-masked regression (date -24pts, five slices +4.8) passes the ci gate in 96% of pairs while the slice gate catches 68.0% at a 16.0% noise false-alarm price (six uncorrected 95% intervals), a real 3-point uniform drift is nearly invisible at this size (ci detection 6.0%), and the power curve says why: 23.3% detection at 240 items, 46.7% at 960, 93.3% at 3840 — a 240-item eval is an alarm for catastrophes, not a caliper for drift |
| 18-semantic-caching | 2026-08-28 | typescript | two-layer semantic response cache (exact map on normalized text + nearest-neighbor cosine serve at a threshold, earliest-entry tie-break, one entry per normalized key, intent labels carried for the evaluator only, no eviction) + hashed lexical feature embeddings as l2-normalized sparse vectors via the hashing trick (word unigram+bigram and boundary-marked char trigram featurizers, fnv1a mod 2^20, cosine as a sparse dot product over the smaller map) + authored 20-intent / 10-family support dataset whose sibling intents differ in one critical slot (reset password vs api key, enable vs disable 2fa) with filler-wrapped trivial variants, low-overlap paraphrases, and normalized-uniqueness validation + pair-class analysis (trivial/paraphrase/near-miss/unrelated pair sets, per-class similarity stats, threshold operating table, inversion rate = fraction of paraphrase x near-miss comparisons ranking the near-miss higher) + seeded zipf-popularity traffic with greeting/tail filler wrapping and adjacent-letter typo injection + replay accounting that prices misses and counts wrong-intent serves against no-cache and exact-only baselines; imports 05's rng, 08's token estimator and pricing, 16's fnv1a; measured — word-feature class means trivial 0.702 / near-miss 0.372 / paraphrase 0.026 with inversion rate 99.2% (char 98.7%), paraphrase recall 0.0% at every threshold 0.50-0.95 while near-miss fpr only dies at 0.80, so the lexical cache is a fuzzy-exact cache, not a semantic one; replay of 2000 zipf requests: no cache $1.7102, exact-only saves 47.1% at zero risk, word@0.80 saves 81.4% with 0 wrong serves, word@0.50 saves 94.4% at 46.5 wrong answers per 1k, char wrong serves are non-monotone in the threshold (44 at 0.50, 85 at 0.70) because the cache's contents are policy-dependent, and char trigrams serve 233 of 287 typoed requests vs word's 157 at 0.75 while scoring enable-vs-disable 2fa at 0.892 (34 vs 2 wrong serves) |
| 17-confidence-calibration | 2026-08-28 | python | confidence calibration measured and repaired: from-scratch multinomial softmax regression on bag-of-words counts over a train-only vocabulary (zero-init deterministic full-batch gd, l2 on weights only, continuable fit so a training curve is repeated fit calls) + reliability bins over max-softmax confidence (equal width, exact 1.0 lands in the last bin) + count-weighted ece / worst-bin mce / multiclass brier / stable log-sum-exp nll + temperature scaling fitted by golden-section search over inverse temperature (cross-entropy is convex in the logits and logits scale linearly in s, so the 1-d objective is convex and the search exact; positive scaling never reorders a row, accuracy untouched by construction and asserted) + selective auto-answer policy (answer iff confidence >= t) priced raw vs calibrated + seeded phrase-bank ticket generator whose per-slot intent-borrow rate is the irreducible-ambiguity knob, with a drifted variant (borrow 0.20→0.35 plus filler vocabulary unseen at training); imports 02's tokenizer; measured — val accuracy is done moving at epoch 100 (0.818, ends 0.772) while val ece climbs 0.034→0.159 through 3200 epochs, raw test reads accuracy 0.795 at ece 0.130 (919 of 1200 predictions claim 0.990 and deliver 0.886, the [0.70,0.80) bin claims 0.753 and delivers 0.450), one validation-fitted T=3.060 takes test ece 0.130→0.030 and nll 0.994→0.592 with zero predictions moved, the t=0.90 escalation policy on raw scores answers 76.6% at 0.886 accuracy (no raw threshold up to 0.99 delivers 0.95) where calibrated answers 37.9% at 0.980, mce 0.303→0.285 because the after-scaling worst bin holds 2 items, and shift (accuracy 0.795→0.539) explodes raw ece to 0.342 where the stale val T recovers only 0.140 and an oracle refit at T=5.691 reaches 0.024 — calibration is a property of the traffic, not the model |
| 16-llm-as-judge | 2026-08-28 | typescript | scripted judge family as latent-utility scorers (quality weight + per-call gaussian noise + authored biases of known size: position bonus to the first-presented answer, ln-length verbosity term around a 120-token pivot, house-provenance self bonus, pass-threshold leniency; every verdict deterministic per (judge, item, presentation order) via fnv1a-derived mulberry32 streams with box-muller gaussians) + two eval modes over one cast (pointwise pass/fail vs pairwise forced choice, exact tie to first presented) + three presentation protocols (as-stored, seeded randomized shared across judges, both-order with abstain-on-flip) + cohen's kappa vs raw accuracy on a deliberately 0.70-imbalanced gold set (constant-rater case defined 0) + attribute-balanced pair sets built exact, not sampled (stored order, provenance, length each uncorrelated with gold by construction) + flip-rate diagnostic, decided/coverage/effective accuracy for abstentions, win-rate-vs-known-truth bias probes (champion-first, house inflation, longer-wins), per-protocol token and cost accounting; imports 05's rng and 08's estimator/pricing; measured — lenient passes 0.955 and still scores 0.745 accuracy on the 0.700 base rate where kappa says 0.198 (always-pass: 0.700 accuracy, kappa exactly 0.000), primacy flips 0.287 of order-swapped pairs yet is perfect (1.000) on the 0.713 it decides, champion-always-first drags a true 0.500 challenger to 0.380 and randomization restores 0.485 at no cost while both-order pays 2x ($2.53 vs $1.26 per 1k pairs) for per-item confidence rather than aggregate accuracy (primacy effective 0.857 vs randomized 0.887), self-preference (0.600) survives order debiasing untouched (0.620) because it rides identity not position, and the two modes are mutually blind: pointwise cannot express position bias (primacy 0.990, identical to calibrated) and pairwise cannot express leniency (lenient 1.000 randomized) |
| 15-embedding-quantization | 2026-08-28 | python | scalar quantization of vector stores behind 13's unchanged indexes (search runs on the dequantized reconstruction, queries stay float): symmetric per-vector int8 (max abs / 127 scale, zero-vector guard) + asymmetric per-dimension uniform grid at parameterized levels (256/16) with min/max or quantile fit, constant-dimension step-0 guard, out-of-grid clipping + int4 nibble packing two codes per byte + exact per-scheme byte accounting (codes plus float32 scales or grid params) + rmse reconstruction error + float rerank recovery (quantized flat top-C, full-precision rerank to top-k with id tie-break, duplicate collapse) + authored dual failure injections (near-constant rogue dimension ~40, rogue outlier rows in U(-40,40)); imports 13's ExactIndex/HnswIndex/datasets and ann_recall (itself 02's recall_at_k); measured — int8-asym flat recall@10 0.985 clustered / 0.989 uniform at 3.99x under fp32 where int4 drops to 0.797 / 0.888 at 7.96x, hnsw's quantization gap is flat +0.013..0.017 across ef 10-160 (converges to the 0.985 flat ceiling, more ef buys nothing back), rerank C=20 makes int8 exact and C=50 makes int4 exact, one rogue dimension crushes per-vector symmetric 0.987→0.515 (informative dims keep ~6 of 255 levels) leaving per-dim at 0.987, five rogue vectors stretch the min/max grid 0.987→0.649 (mean step 0.2051 vs 0.0062 needed) leaving per-vector at 0.987, and quantile-0.002 fit recovers 0.983 |
| 14-context-window | 2026-08-28 | typescript | context assembly under a token budget as pure policy functions (full history, sliding window keeping a contiguous suffix of whole turns, head-and-tail with pinned first turns, summarize-evicted reserving a budget share for an extractive summary and degenerating to sliding-window while everything fits; system prompt and current user turn always pinned, over-budget flagged, context tokens defined as the sum of per-part estimates so fitting and reporting share one arithmetic) + luhn 1958 extractive salience (frequency-significant words, best cluster scored count^2/span under a gap cap) vs rarity salience (mean ln(N/sentence-frequency) over unique content words) behind one summarize interface + seeded ops-conversation generator planting 12 single-occurrence nonce facts per conversation (standalone vs buried sentence classes, probes ask by key at lag buckets 1-2/3-8/9-20 exchanges, generation-time validation that each value occurs exactly once) + retention-by-lag/class metrics with per-call token and dollar accounting; imports 08's token estimator and pricing and 05's rng; measured — sliding window is a step function in lag (100% inside the 800-token window, 23.8% past it), luhn summarization is worse than no summary at all (71.3% vs 74.6% overall, 15.0% long-lag, falling to 61.7% as the summary share rises to 50%) because frequency salience keeps the chatter and a once-stated decision is the rarest thing in a transcript, rarity salience at identical budget and cost reaches 85.8% overall and 57.5% long-lag (92.5% at 50% share, where luhn and rarity slope in opposite directions), buried facts pay a mean-dilution tax under sentence scoring (82.5% vs 89.2% standalone), and cost is flat across policies at a fixed budget ($0.0739-0.0744/conv vs $0.1091 full-history) while full-history's call size grows 66.9 to 1876.7 tokens over 30 exchanges |
| 13-ann-hnsw | 2026-08-28 | python | hnsw approximate nearest neighbor from scratch (geometric level assignment floor(-ln u / ln M), per-layer greedy descent, best-first beam search of width ef with (distance, id) tie-breaking, bidirectional linking with degree caps M / 2M and re-selection shrink, the paper's algorithm-4 neighbor-selection heuristic with fill-from-discarded, naive M-closest ablation mode) + exact flat index as one vectorized squared-L2 scan with id tie-break + distance-computation accounting on both indexes + layer-0 reachability integrity check + seeded gaussian-mixture and uniform synthetic vector datasets with uniform outlier queries; imports 02's recall_at_k (exact top-10 as the relevant set); measured — recall 0.979 at 18.5x fewer distance computations than exact and 0.995 at 15.9x, with the last 0.005 of recall costing ef 80→320 and a fall to 2.5x; M=4 builds at 445 dists/vector for 0.963 vs M=32 at 7373 for 0.998; the selection heuristic vs naive M-closest on tight clusters is 0.997 vs 0.809 with 145 of 2000 nodes stranded unreachable on layer 0 (uniform control: 0.015 apart, 4 nodes), uniform 32-d is harder than clustered for both (0.861 vs 0.997 at identical settings); wall clock at n=3000 is a near-tie with the vectorized exact scan because python per-node overhead eats the ~15x distance-count win — the count is the portable number |
| 12-groundedness-scoring | 2026-08-28 | python | lexical groundedness scorers as unsupported-claim detectors: content-token overlap precision with a stopword filter + max per-sentence tf-idf cosine (02's TfidfIndex fitted on the context's own sentences, 10's splitter) + numeric consistency gate (digit-literal extraction with thousands joining, fraction of claim numbers present in context, no-numbers passes) + negation-parity heuristic (7-cue list, hard zero on mismatch with the best-matching sentence) + exact pairwise ROC-AUC with half-credit ties + Youden's J threshold sweep (flag-everything scores J=0, unlike best-F1 which degenerated on the 25/35 class balance) + authored 10-context / 60-claim hallucination taxonomy (verbatim/paraphrase/synthesis/negated-paraphrase supported, entity/number/negation/antonym edits + fabrications + outside-knowledge unsupported); measured — sentence cosine ranks hallucinations ABOVE truth (AUC 0.432, mean unsup 0.762 vs sup 0.668) because minimal edits keep a sentence's words while paraphrases lose them, the two lexical methods' best thresholds land at 1.000 (trust only verbatim copies, FPR 0.720), the numeric gate is precision 1.000 at FPR 0.000 but misses the 1-of-2-numbers-real swap (score 0.5), negation parity buys 7/7 flip recall for 4/4 zeroed negated paraphrases, and 2 of 4 antonym flips are bag-of-words-identical to a true sentence and score 1.0 under every method |
| 11-prompt-caching | 2026-08-27 | typescript | simulated provider-side prefix cache modeling the documented semantics (longest-cached-prefix hit with exact length-prefixed keys, writes billed only for the delta past the hit, ttl expiry with free refresh-on-read at the entry's own ttl, min cacheable prefix 1024 tokens, 4-breakpoint cap, 20-block lookback per breakpoint) + read/write cost multipliers per ttl (0.1x reads, 1.25x 5m writes, 2x 1h writes over parameterized base pricing) + breakpoint placement strategies (none, static prefix, incremental tail, lookback-spaced) + seeded phrase-bank agent workload with interleaved conversations, volatile-header cache-bust variant, unique one-shot requests, and tool-heavy turns; imports 08's token estimator and 05's rng; measured — incremental breakpoints save 78.0% input cost vs no caching (hit rate 89.6%) where static-only saves 44.2%, one volatile header line drops hits 59/60 to 0/60 and lands at 1.252x of not caching, unique one-shot prompts with caching on bill exactly 1.250x, a gap sweep flips the 5m ttl from 0.246x to a pure 1.250x loss the moment turn gaps pass the ttl (1h ttl holds 0.341x until 70m, then 2.000x), and 26-block turns outrun the 20-block lookback so the naive tail breakpoint rewrites all history every turn (1.072x, worse than no caching) until one spaced marker restores 0.362x |
| 10-chunking-strategies | 2026-08-27 | python | regex sentence splitter with character spans (abbreviation guard, non-ascii-safe uppercase boundary check via str.isupper) + fixed word-window chunker with optional overlap + greedy sentence-packing chunker under a word budget, all emitting exact doc substrings with [start, end) offsets + exact answer-containment relevance over chunks with split-rate, best-coverage (char overlap of answer span with best chunk), and context-words-at-k metrics, over an authored 10-doc / 40-query ops corpus with verbatim-unique answer sentences; imports 02's bm25/tokenizer/metrics (chunking changes the index contents, not the scorer); measured — fixed-80 splits 42.5% of answers and 17 of its 20 hit@5 misses are boundary splits not ranking failures, sentence packing at identical index size (5391 words) holds splits at 0% and wins hit@5 0.850 vs 0.500 with a smaller context bill (333.7 vs 388.2 words), overlap-20 buys back 15/17 splits for +30.4% index but newly splits 1 answer plain fixed-80 kept whole (stride 60 moves every boundary, overlap does not just add windows), and a split answer's best chunk still holds 71.1% of it on average |
| 09-concurrency | 2026-08-27 | typescript | fifo counting semaphore (direct permit handoff, double-release guard, high-water/queue stats) + bounded-parallelism map over it (fail-fast and per-item settled variants, input-order results) + micro-batcher with size/deadline dual flush trigger and a batch-identity check against stale uncancellable virtual timers + simulated llm batch endpoint (80ms + 20ms/item ±10% seeded jitter, fifo admission cap 8, 400-token per-call overhead + 60/30 per-item tokens, whole-batch validation rejection naming no item) + poisoned-batch recovery strategies (fail-all, capped retry-whole, one-by-one, bisect) + seeded exponential inter-arrival process; imports 06's clock/percentile and 05's rng; measured — workers past the server cap hold 79.3 req/s while request p50 doubles per doubling (100ms at 8 workers → 793ms at 64, the queueing just moves server-side), batch 8 captures 90% of batch 32's overhead amortization ($1.830 → $0.780 per 1k items) while a call's duration and an item's wait point opposite ways on that sweep (call p50 100ms → 724ms as the batch grows, item p50 3040ms → 771ms, because every item is queued behind the other 239 at t=0 and a bigger batch drains that queue sooner), the latency batching actually costs shows up only once items arrive over time — holding a micro-batch open 100ms on ~20ms arrivals cuts cost 55% for +175ms p50 — and bisect isolates 1 poisoned item of 32 in 11 calls vs 33 one-by-one but inverts by k=4 (31 calls and 21520 input tokens vs 17040, failing halves repay the overhead at every tree level) |
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
Re-attempted 2026-08-28: ref deletion still denied at the remote.
Re-attempted again 2026-08-28 (20-guardrails run): `git push origin --delete`
on claude/nice-ritchie-9e3u30 failed with a sideband disconnect and the ref
survives, same limited-write outcome as before. the nine stale claude/* branches
are all merged into or superseded by main and safe to delete by hand from the
github branches page. the two twins named above (mz3nch, wbddzz) were already
resolved in the 06 landing, so no branch-rescue build was owed this run.
Re-attempted 2026-08-29 (22 run): still denied, same sideband disconnect on
ref deletion; nothing on those branches is unlanded, deletion stays a
by-hand task on the github branches page.
Re-attempted 2026-08-29 (23 run): still denied, batch and single-ref forms
both 403 at the remote. Same conclusion: every stale claude/* branch is
merged or superseded, delete by hand from the github branches page.
Re-attempted 2026-08-29 (24 run): still denied, batch and single-ref forms
both 403. Unchanged: nothing on those branches is unlanded, deletion stays
a by-hand task on the github branches page.
Re-attempted 2026-08-29 (05-resumable run): still 403 at the remote.
Unchanged: nothing on those branches is unlanded, deletion stays a by-hand
task on the github branches page.
Re-attempted 2026-08-30 (06-outage run): still denied, sideband disconnect
on ref deletion. Unchanged: all nine stale claude/* branches are merged or
superseded by main, deletion stays a by-hand task on the github branches
page.

## FINDINGS

Open issues found by review, worst first. High = wrong results or wrong
claims, medium = robustness or consistency, low = performance wrong in kind.
Fixed items stay listed with their fix date so the history reads in one place.

- [high] 14 — "full-history's call size nearly triples from exchange 15 to 30"
  is refuted by the two numbers printed three lines above it: 1039.4 to 1876.7
  is 1.806x. it nearly doubles. no pair of published numbers in the project
  triples over that span — 1 to 15 is 15.5x and full-history against
  sliding-window at exchange 30 is 2.4x, so it is not a mislabelled pair
  either, just a wrong magnitude word. the same claim is on the front page:
  the root readme's index row for 14 says "full history nearly triples by turn
  30", which is the only place a reader who never opens the project sees it.
  the argument the sentence is making survives — full-history grows without
  bound, the budgeted call is flat — so no conclusion moves, only the
  multiple. same shape as the 10 finding fixed 2026-08-29, and the fix needs
  both readmes. found 2026-08-30
- [fixed 2026-08-30] 14 — the buried-fact bullet claimed "buried facts pay a
  tax under every policy that looks at sentences" and that "the window
  policies dont care, they keep or drop whole turns". the table under it
  refutes both halves. luhn-25% at 800 is a sentence-scoring policy and holds
  buried facts *better* than standalone (73.3% vs 69.2%, a -4.2 point gap),
  and sliding-window, which never looks at a sentence, has the widest split of
  any row in the sweep (78.3% vs 70.8%, +7.5) — wider than the 89.2/82.5 pair
  the bullet quotes as the tax itself. and none of the eight gaps clears
  sampling noise at 120 probes a side: the largest is rarity-25% at 400, 11.7
  points at z=1.84, and the quoted rarity-25%-at-800 pair is z=1.48. so the
  sentence read a mechanism out of noise and then attributed it to the wrong
  half of the table. the lag buckets are exactly balanced across the two
  classes (40 short / 40 medium / 40 long each), so the gaps are not a lag
  confound — but buried intro turns are 73.9 tokens against standalone's 34.3,
  which is a real mechanism for a *window* gap if the effect ever turns out to
  exist. bullet rewritten around what the sweep shows, and the open question
  that rested on the old premise ("the buried-fact tax comes from mean-based
  scoring") now asks whether the effect exists at all. three tests pin it: the
  signs disagree across policies at 800, no row in the sweep reaches z=2, and
  the readme quotes the numbers the run produces — including the four derived
  figures (11.7, z=1.84, 73.9, 34.3) that `main.ts` never prints and nothing
  else would have caught going stale. no measured number moved, root readme
  quotes none of this. found and fixed 2026-08-30
- [medium] 14 — `runCell` on an empty conversation list returns NaN for
  `meanInputTokensPerCall` (0/0) and `costPerConversation` (divide by
  `conversations.length`), and `callTokensAtExchange` divides by the same
  zero. unreachable from `main.ts`, which pins 20 conversations, and `rate`
  already guards its own `total === 0`. same shape as the 01, 09, 10, 11, 12
  and 13 findings below — six projects now, worth one pass rather than six.
  found 2026-08-30
- [low] 14 — the rarity scorer can never summarize a single sentence. with
  N=1 every content word has sf=1, so every term scores ln(1/1)=0, the mean is
  0, and `summarize` drops it on the `score > 0` filter — an evicted block
  that collapses to one sentence yields an empty summary and the reserved
  budget is spent on nothing. not reachable in the published sweep, where the
  smallest evicted block is many turns, but it is a floor the scorer has and
  the docstring ("a sentence of once-seen words scores ln(N)") doesn't
  mention. found 2026-08-30
- [low] 14 — `summarize` picks the same sentence twice when the evicted turns
  repeat one verbatim: the filler bank is 10 templates over 18 topics, so
  collisions happen, and identical sentences score identically and rank
  adjacent. small — 15 of 2939 picked sentences at rarity-25%/800 (250
  tokens), 3 of 3080 at luhn — but it is summary budget spent on text already
  in the block. found 2026-08-30
- [low] 14 — `sentences` treats only `.`/`!`/`?` as terminators, so an
  ideographic full stop doesn't split ("東京 は 大きい。next one." is one
  sentence). the docstring says the split is deliberately simpler than 10's
  because the corpus is generated, which is true here, but the readme also
  offers the summarizer as the transferable part. same family as the open
  02/04 unicode tokenizer finding below. found 2026-08-30
- [fixed 2026-08-29] 13 — `reachable_on_layer0` ran its walk out from node 0,
  which is only the first vector that happened to be indexed and has no part
  in any search. layer-0 links are not symmetric — `_shrink` drops the
  back-link when a node runs over its degree cap — so the node the walk starts
  from decides the answer, and node 0 is the wrong one: on a seeded naive
  graph (300 vectors, dim 8, M=4, seed 2) node 0 reaches 20 of 300 where the
  entry point reaches 261, and on another (400, dim 16, seed 1) it is 43
  against 348. off by an order of magnitude in both directions. the number the
  readme publishes off this probe — "strands 145 of 2000 nodes" — is the
  ablation's whole case for the selection heuristic being load-bearing, and it
  was right by luck: node 0 and the entry point agree on all five published
  configurations (3000/3000, 2000/2000, 1855/2000, 2000/2000, 1996/2000), so
  no published number moved. 21-vector-store-persistence had already written
  the same diagnostic correctly as `reachable_live_from_entry`, so this was
  also the same metric computed two ways in two folders. walks from
  `self._entry` now, and the empty guard keys on `self._entry is None` rather
  than `_size == 0`. `test_reachability_is_probed_from_the_search_entry_point`
  pins the seed-2 graph where the two starts disagree 261 vs 20. 15 and 21
  both import this index and both suites stay green; neither calls this
  method, so nothing to port. found and fixed 2026-08-29
- [medium] 13, 21 — "reachable from the entry point" is a lower bound on what
  search can see, not the set itself, and both projects' docstrings read it as
  the set. the layer-0 beam does not start at the entry: it starts wherever
  the greedy descent through the upper layers lands, and upper-layer links are
  chosen independently of layer-0 links, so a node outside the entry's layer-0
  closure can still be reached. closing the descent's whole landing set gives
  1926 of 2000 on the naive tight-clusters row against the 1855 published — 74
  nodes provably unreachable by any query rather than 145. the sound version
  of the claim is that complement; the published one is a different, smaller
  set that happens to be easy to compute. not folded into the fix above
  because it is a second claim and it lives in 21 as well. found 2026-08-29
- [medium] 13 — duplicate-heavy corpora strand almost everything and `search`
  quietly returns short. 50 identical vectors at M=4: all distances tie, the
  tie-break is by id, so every later node links to the same nine lowest ids
  and shrink prunes the back-links — 41 of 50 nodes end up unreachable and
  `search(q, k=10, ef=50)` returns 9 results with 50 vectors indexed, no error
  and no signal. this is hnsw's known crowding pathology rather than a coding
  error, which is why it is not the fix, but `test_duplicates_are_all_
  retrievable` uses 5 duplicates among 30, passes, and reads as a guarantee
  the index does not have. "tradeoffs and where it breaks" doesn't mention it.
  found 2026-08-29
- [low] 13 — "the naive graph is literally disconnected" is the one word the
  measurement doesn't support. layer 0 is a single weakly connected component
  of 2000 in every ablation arm; the 145 stranded nodes still link out to the
  core, the core just has no way back. directed unreachability, which is the
  thing that matters for search, but not a split graph. found 2026-08-29
- [low] 13 — the wall-clock section builds a fresh `ExactIndex` and starts the
  timer before the first search, so the lazy `np.vstack` of all 3000 rows is
  charged to the exact baseline inside the per-query loop: 2.07ms once, 0.014
  ms/query over 150 queries, ~3.5%. the hnsw side is timed on an index already
  built and warm. the readme's own two numbers are 0.339 and 0.328, 3.3%
  apart, so the artifact is the size of the gap it reports — but the section's
  claim is "near a tie" and that survives it, and the numbers are labelled as
  moving a few percent run to run. found 2026-08-29
- [low] 13 — `main.py` prints a `dists/query` column in the ablation that the
  readme table drops, and it is the cost side of the heuristic's case: the
  heuristic spends 128 per query against naive's 116 on tight clusters and 382
  against 363 on uniform, ~10% more. the conclusion is untouched — 0.188 of
  recall for 10% more distances is not a close call — but the readme argues
  the heuristic is load-bearing without ever showing what it costs. found
  2026-08-29
- [medium] 13 — `main.py` and the introspection helpers die on an empty index:
  `degrees(0)` returns `[]` and `max([])` raises, `ground_truth` on an empty
  query set reaches `mean([])`, and the `vs exact` column divides by a
  `dists/query` that is 0 when nothing was searched. all unreachable from the
  entry point, which pins its own 3000 vectors and 150 queries. same shape as
  the 01, 09, 10, 11 and 12 findings below. found 2026-08-29
- [fixed 2026-08-29] 12 — `extract_numbers` ran `\d+(?:\.\d+)?` over the raw
  text with no token boundary, so it pulled digits out of the middle of
  identifiers: "p99" yielded 99, "ES256" yielded 256. those are not quantities
  the text asserts, and because the context spells them the same way the
  phantom number always matched, inflating both sides of the
  `matched / claimed` fraction the numeric gate scores on. the one number swap
  the gate misses, c06-5, swaps 210 ms for 610 ms — two figures, one right —
  and scored 2/3 instead of 1/2 because "p99" was counted as a third figure
  that checked out. the readme already stated the honest number ("half its
  numbers check out and the score (0.5) clears the threshold") while the code
  printed 0.667, and `test_integers_and_decimals` pinned the wrong behaviour
  with the p99 case written into it. a literal has to start at a token
  boundary now (`(?<![\w.])`), which also stops "v1.2.3" reading as 2.3 and 3.
  no operating point and no category cell moved — c06-5 clears 0.328 either
  way — but c06-5 goes 0.667 → 0.500 and four published numbers follow it:
  numeric_gated AUC 0.553 → 0.560 and mean unsup 0.604 → 0.599,
  negation_aware AUC 0.615 → 0.622 and mean unsup 0.439 → 0.435. readme table
  and the "ceiling: AUC" sentence updated; root readme quotes only
  sentence_cosine's row, which is byte-identical. nothing else in the repo
  extracts numbers from text, so nothing to port. found and fixed 2026-08-29
- [low] 12 — residual limit of the same fix: the boundary guard is on the left
  only, so a digit run glued to a *following* word still reads as a number
  ("38ms" → 38, which is right) and one glued after a hyphen still reads as
  one ("COVID-19" → 19, which is not). deliberate — a number followed by its
  unit is a genuine assertion and this dataset has no hyphenated identifiers —
  but the rule is asymmetric and worth knowing before the extractor is reused.
  found 2026-08-29
- [low] 12 — "the only claims they trust are the verbatim copies" is true of
  the supported side, which is what the sentence's own FPR clause is about,
  but overlap at its 1.000 threshold leaves three unsupported claims unflagged
  too. two are the bag-identical antonym flips the readme discusses four
  bullets later; the third, c07-4, is nowhere: it deletes "not" from
  "Delivery order is not guaranteed", so its content tokens are a strict
  subset of the context and precision comes out exactly 1.0. deleting a word
  is invisible to a precision metric — that is the sharper version of the
  point the paragraph is making, and it is missing from it. found 2026-08-29
- [medium] 12 — `main.py` indexes `rates[category]` for all 10 names in
  `CATEGORY_ORDER`, so a dataset missing any one category dies with a bare
  `KeyError`, and the row's `n` is read off the `total` left behind by the
  last method's loop rather than from the category itself. both are
  unreachable from the entry point, which pins the committed 60 claims and all
  10 categories. same shape as the 01, 09, 10 and 11 findings above. found
  2026-08-29
- [low] 12 — `main.py` recomputes `flag_rates_by_category` inside the
  category × method loop: 40 full passes over the 60 scored claims where 4
  would do, since the threshold only varies by method. recomputation per row
  rather than per method, so it is wrong in kind, but at n=60 it is
  microseconds. `auc` likewise sorts both score lists and never uses the
  ordering — dead, not wrong. found 2026-08-29
- [fixed 2026-08-29] 11 — the volatile-header experiment divided both of its
  rows by the *stable* workload's no-caching cost, so the volatile row priced
  one traffic shape against a different one's baseline. the per-request
  `session N request M` line is 300 extra tokens the denominator never saw, so
  the published ratio came out 1.252x where the honest same-workload ratio is
  exactly 1.250x — the 1.25x write multiplier and nothing else, which is the
  whole point of the experiment: zero reads, zero uncached tokens, every token
  paying the write premium. the 0.002 is small but the shape is not: it is a
  numerator and a denominator from different traffic, and this was the only
  experiment of the five doing it (1, 4 and 5 all baseline against their own
  events, 3 against its own). `runVolatileHeader` builds each variant's events
  and baseline together now. two tests bind it: the volatile ratio must be
  `1.25` to 10 places with `readTokens` and `uncachedTokens` both 0, and each
  row's ratio must equal its cost over its own no-caching replay. readme and
  root readme both updated, 1.252x → 1.250x; no other number moved and the
  other four experiments are byte-identical. found and fixed 2026-08-29
- [medium] 11, 18 — both projects print a column called `hit rate` and compute
  it differently: 11 is token-weighted (`readTokens / prospective`, so the
  89.6% in experiment 1 is a fraction of input tokens served from cache) and
  18-semantic-caching is request-weighted (`hits / requests`). each is the
  right metric for its own question and 11 prints the request count alongside
  it as `hits 59/60`, so neither number is wrong — but the same label means
  two things in two folders, which is exactly the reading error the label is
  supposed to prevent. left open rather than renamed in the fix commit: it
  touches 18's output and 18 has not been reviewed yet. found 2026-08-29
- [low] 11 — experiment 5's readme sentence says "at 26 blocks per turn the
  tail breakpoint cant see back far enough: hit rate collapses from 77.2% to
  15.5%". 77.2% is the *spaced-15* row at 26 blocks, not the 10-block row the
  sentence has just been describing — that one is 79.1%. read as a
  strategy-vs-strategy comparison at 26 blocks it is correct, read as the
  before/after of widening the turn it names a number that is not in that row.
  the two candidates are 1.9 points apart so nothing turns on it. found
  2026-08-29
- [low] 11 — `runStrategyComparison` divides by `rows[0].totals.inputCost`
  with no guard, so an event list whose baseline costs nothing yields NaN
  savings rather than an error. same shape as the 01 and 10 findings above and
  likewise unreachable from the entry point, which pins its own 6x10 workload.
  found 2026-08-29
- [fixed 2026-08-29] 10 — the context bullet claimed "fixed-160 more than
  doubles ctx w@5 vs fixed-80" and printed the refuting numbers in the same
  breath: 755.8 vs 388.2 is 1.9467x, under the 2x the prose asserted. the pair
  that does more than double is sentence-160 over sentence-80 (685.3 vs 333.7,
  2.0537x), which the same sentence waved off as "the same trade" — so the
  multiple was not just rounded up, it was attached to the wrong pair. the
  computation was never wrong; only the sentence was. both multiples are stated
  explicitly now and `test_readme_context_multiples_match_the_run` parses the
  `(bigger vs smaller, Nx)` triples back out of the readme and checks them
  against the run, so the prose cannot round them together again. no measured
  number moved and `main.py` output is byte-identical. found and fixed
  2026-08-29
- [medium] 10 — `evaluate_config` on an empty query list dies inside 02's
  `mean` with "cannot take the mean of an empty list", reached through
  `split_rate`; the function already guards the other empty input ("chunker
  produced no chunks") so the asymmetry is the defect, not the crash. same
  shape as the 08 and 09 findings above and, like them, unreachable from the
  entry point: `_read_jsonl` rejects an empty queries file and `main.py` pins
  its own 40. left open rather than fixed because the twins in 08 and 09 are
  typescript, so it is not the identical change. found 2026-08-29
- [low] 10 — `ctx w@5` sums `word_count` per chunk over the top 5, so the two
  overlap rows count every duplicated word once per chunk that carries it.
  deduping the top-5 character spans puts ov-20 at 357.3 words rather than
  388.8 and ov-40 at 312.4 rather than 395.4. the column is labelled "the words
  you would stuff into a prompt if you passed the top 5 chunks along", which is
  literally what naive concatenation costs, so it is honest as defined — but
  deduped, ov-40 is a *cheaper* context bill than sentence-80 (312.4 vs 333.7)
  rather than a dearer one, and the readme uses this column for its efficiency
  argument. no published conclusion turns on it: overlap's stated cost is index
  size, and sentence-80 still wins hit@5 0.850 vs 0.800. found 2026-08-29
- [low] 10 — "per word of prompt, sentence-80 is the efficient point on this
  corpus" is the one reading the table does not support. per 100 context words
  sentence-40 returns hit@5 0.467 against sentence-80's 0.255 and mrr@10 0.386
  against 0.209, and it beats every fixed config at a fifth of fixed-160's
  context. sentence-80 is the knee in *marginal* return (40 → 80 buys 0.093
  hit@5 per 100 extra words, 80 → 160 only 0.021), which is probably what was
  meant, so this is an ambiguous sentence rather than a false one — logged
  rather than rewritten. found 2026-08-29
- [fixed 2026-08-28] 09 — the batch-size sweep's latency column was labelled
  `item p50` / `item p95` but measured a call's duration, timed from the
  moment a client worker picked the batch up. all 240 items are handed to the
  pool at t=0, so the client-queue time an item spends waiting behind the
  other 239 — the time a bigger batch removes — was outside the measurement
  entirely. the column climbs with batch size (100ms → 724ms) and the readme
  read it as the item's latency: "the latency curve doesnt flatten, it keeps
  climbing with n. So the knee is early: past batch 8 or so you are trading a
  lot of latency for cents." the trade is not there. measured from job start,
  an item's wait goes the other way — 3040ms at batch 1 down to 771ms at batch
  32 — so on this closed job batching wins cost and latency together, and the
  makespan column two places to the left (6.05s → 1.46s) was already saying so.
  the root readme repeated it as "batch 8 ... at a third of its latency", where
  batch 8 is in fact slower per item end-to-end than batch 32 (984ms vs 771ms).
  `runBatchSizeSweep` records both series now: `callP50Ms`/`callP95Ms` are the
  old numbers under an honest name (character-identical, nothing moved) and
  `itemP50Ms`/`itemP95Ms` are the wait from job start. the real latency price
  of batching is experiment 3, where items arrive over time and nothing is
  queued behind anything — that one measures from submit and was always right.
  no other project pairs a client pool with a latency percentile (06 measures
  every request from its own arrival), so nothing to port. found and fixed
  2026-08-28
- [medium] 09 — the isolation strategies all run serially, so the `elapsed`
  column reads bisect 1494ms against one-by-one 3232ms for a single poisoned
  item. but one-by-one is embarrassingly parallel and bisect is inherently
  adaptive — 33 independent calls through this repo's own `mapBoundedSettled`
  against the 8-call server cap would land near 450ms and beat bisect outright.
  no readme conclusion rests on `elapsed` (the calls and tokens columns carry
  the argument, and those are parallelism-independent), but the column is
  printed next to them and invites exactly the comparison it cannot support.
  found 2026-08-28
- [medium] 09 — `runWorkerSweep`, `runBatchSizeSweep` and `runMicroBatchSweep`
  all die on a zero-item config inside 06's `percentile` with "cannot take a
  percentile of an empty list", and `throughputPerSec` would be 0/0 even if
  they survived. confirmed on all three. same shape as the 08 finding below;
  unreachable from the entry point, which pins its own counts. found 2026-08-28
- [low] 09 — `Semaphore.makeRelease` updates `heldHighWater` on the direct-
  handoff path, where `held` is unchanged by construction, so the line can
  never raise the high water mark. dead, not wrong. found 2026-08-28
- [low] 09 — the readme calls the cost curve "just overhead amortization,
  400/n + 60 tokens per item", but 240 items dont divide into batches of 32,
  so the last call carries 16 and the batch-32 row prints 73.3 tokens/item
  against the formula's 72.5. the printed number is the right one; the prose
  formula holds only when the batch size divides the item count. found
  2026-08-28
- [fixed 2026-08-28] 08 — the flaw-pricing table is a paired comparison, each
  flawed task against its own clean twin under the guarded policy, but the
  twin was run on an unrelated seed (`BASE_SEED + 777_000 + t * 101`) while
  the flawed run used the policy seed (`BASE_SEED + p * 10007 + t * 101`).
  the two runs therefore drew independent model-latency jitter, so the
  `extra-ms` column carried the noise of both runs instead of cancelling it.
  the estimator stays unbiased, but the published value for `unknown-tool`
  came out at 584ms for 1.0 extra model calls — below the 600ms base latency
  a single model call costs, a marginal cost the mechanism cannot produce.
  every flawed task has `fetchTransientFailures: 0`, so model latency is the
  only rng consumer and the twin's draws are an exact prefix of the flawed
  run's once the seeds match: the shared calls cancel term for term and the
  difference is the marginal cost of the flaw. `seedFor(policyIndex,
  taskIndex)` is now one helper and the twin reuses the seed of the run it is
  subtracted from. token, cost and model-call columns are seed-independent
  and are character-identical; only `extra-ms` moved (wrong-type 983 → 964,
  missing-field 800 → 844, extra-field 1269 → 895, unknown-tool 584 → 723,
  stubborn 785 → 836, slow-corrector 662 → 991) and the readme sentence that
  called the column "rough" is replaced by what it now is. the readme's
  policy table and the stubborn-burn block are untouched. no other project
  runs a paired twin comparison, so nothing to port. found and fixed
  2026-08-28
- [medium] 08 — `scriptedModelTurn` builds the final answer with
  `task.finalTemplate.replace("{last}", lastValue)`, and `String.replace`
  reads `$&`, `` $` `` and `$'` in the *replacement* as patterns. a tool value
  containing any of them is rewritten: `search_notes` returning a note titled
  `a $& b` produces `result: a {last} b`, silently scored wrong-answer with
  no sign the answer was mangled rather than mis-derived. tool output is the
  one string here that is not authored in the dataset, so this is exactly
  where it can appear. the committed corpus has none. `replaceAll` with a
  function replacement, or a split/join, closes it. found 2026-08-28
- [medium] 08 — `runExperiment` on an empty task list throws `cannot take a
  percentile of an empty list` out of 06's `percentile`, and `loadTasks`
  explicitly accepts an empty dataset (`tests/tasks.test.ts` pins it). so the
  one edge case the loader promises to support crashes one layer down with an
  error naming a statistic instead of the empty corpus, and `meanTaskMs`
  would be NaN even if it survived. `savedPct` in `report.ts` is the same
  shape: 0/0 when no task is stubborn. found 2026-08-28
- [low] 08 — `flawGroup` labels a multi-flaw task by `kinds[0]`, so a task
  carrying a wrong-type and a missing-field intent is priced entirely under
  wrong-type. no committed task has two flaw kinds, so no published number is
  affected; the classifier is just narrower than the dataset it might be
  handed. found 2026-08-28
- [low] 08 — a tool result with `ok: false` advances the scripted model to the
  next intent exactly like a success, and `lastValue` keeps the previous
  successful value, so a task whose second tool errors still emits a final
  answer built from the first tool's output. documented as "intents advance
  on tool results" and no committed task makes a tool fail (`fetch-flaky-4`
  succeeds on attempt 5 of 5), so nothing measured depends on it — but the
  readme's open question about garbage tool results lands here, and today the
  loop would report an error result as progress. found 2026-08-28
- [low] 11, 08 — 11-prompt-caching imports 08's `estimateTokens` in
  `cache.ts` but computes the same quantity inline in `workload.ts:233` as
  `Math.ceil(turn.assistantText.length / 4)`, without the `max(1, ...)` floor
  the shared helper applies. the two disagree only on empty text (1 vs 0) and
  11's assistant turns are never empty, so no number moves; it is the same
  metric computed twice in one repo. found 2026-08-28
- [fixed 2026-08-28] 07 — the separability section printed the hardest
  non-duplicate pair with a hardcoded `(same-topic vocabulary overlap)`
  annotation, whatever pair came out on top, and the readme repeated it as
  "two same-topic paragraphs about limiters". the pair is
  `cache-03--truncate` vs `ratelimit-03--truncate` at 0.024 — caching against
  rate limiting, two different topics that happen to share retry vocabulary.
  so the readme's demonstration that "topical overlap is nearly invisible at
  the shingle level" rested on a pair with no shared topic at all. the cause
  is upstream: `docs.jsonl` has carried a `topic` field from the start and
  `load_base_docs` read `doc_id` and `text` and dropped it, so nothing in the
  code could check the claim. `Doc` carries `topic` now, `build_corpus`
  propagates it to mutants, and `topic_relation` derives the label from the
  two docs instead of asserting it. the entry point also prints the hardest
  pair that genuinely is same-topic (`index-02--truncate` vs
  `index-03--drop` at 0.011, less than half the cross-topic ceiling) and both
  means (same-topic 0.0005 over 864 pairs, cross-topic 0.0001 over 9072), so
  the claim now has the evidence it needs: sharing a topic does move a pair
  up, 5x, but 5x of nearly nothing, and one shared turn of phrase across
  topics clears the whole same-topic ceiling. the conclusion survives, its
  supporting number was the wrong one. no measured number moved — every
  other line of the entry point is character-identical. no other project
  makes a same-topic claim or carries a topic field, so nothing to port.
  found and fixed 2026-08-28
- [medium] 07 — `shuffle_sentences` loops on `while sentences == original:
  rng.shuffle(sentences)`, so a document whose sentences are all identical
  never escapes: shuffling a list of equal elements can never compare
  unequal. confirmed as a hang, not an exception — `shuffle_sentences("hi
  there. hi there.", Random(1))` runs forever. boilerplate with a repeated
  sentence is exactly the duplication pattern the mutation set says it
  models, so this is reachable on real input. the committed corpus has no
  such doc. a bounded attempt count that gives up and returns the original
  would close it. found 2026-08-28
- [medium] 07 — both head-to-head operating points are read off the same
  10296 labeled pairs they are then scored on. `best_t` is picked by max f1
  over `JACCARD_SWEEP` and `best_d` by max f1 over `HAMMING_SWEEP`, then the
  final section reports "minhash lsh + verify 1.000, simhash 0.942" as each
  method's number. for exact jaccard it costs nothing — separation is 0.024
  to 0.280, so every threshold in that band scores 1.000 and the choice is
  not load-bearing. for simhash it is load-bearing: d<=20 wins only because
  it is best on this set, and it already sits past the nearest non-duplicate
  at 19, so 0.942 is an oracle number no deployed threshold could pick. the
  readme notes the d=19 overlap but never says the operating point was
  selected on the scored set. found 2026-08-28
- [low] 07 — `with_typos` falls through: the `elif op == "drop"` arm is only
  reached when the swap guard fails, so `op == "swap"` at the last index (and
  `op == "drop"` on a 1-character string) lands in the `else` and doubles a
  character instead. over 30000 draws on a 10-char string the split comes out
  10964 double / 10144 drop / 8892 swap against the uniform thirds the
  docstring implies. it is a mutation generator and the corpus is seeded, so
  no measured number depends on it. same species as 03's stem fall-through.
  found 2026-08-28
- [low] 07 — the minhash accuracy table prints `mean abs err X all pairs,
  Y duplicate pairs (max Z)` where Z is `max_absolute_error` over all 10296
  pairs while Y is over the 360 duplicate pairs, so the parenthetical sits
  next to a number computed over a different population and reads as its max.
  checked at every k in the sweep: the all-pairs argmax is a duplicate pair
  each time (k=8 through k=128), so the five published maxima are all
  correct as duplicate-pair maxima too and nothing needs restating. the
  label is still unqualified. same shape as the fixed 06 finding.
  found 2026-08-28
- [low] 07 — `hamming_distance` calls `int.bit_count()`, which is python
  3.10+, and the readme's run instructions name no minimum version while
  `requirements.txt` pins only pytest. on 3.9 the project fails at the first
  simhash comparison. found 2026-08-28
- [fixed 2026-08-28] 06 — the results table's `p50` and `p99` columns were
  computed over requests that succeeded, and nothing in the table said so.
  success rates run 10.5% to 100% down that column, so the rows are latencies
  over different populations and reading the column down compares them as if
  they werent. no-retry read `p50 40ms`, the fastest number in the table, ahead
  of every strategy that actually works — but 89.5% of its requests were
  rejected at t=0 and never entered the percentile, so its median request took
  0ms. fixed-100ms read 229ms against 800ms over every request, because a
  give-up spends its whole 8-retry budget and then counts for nothing.
  `runScenario` reports `p50AllMs` over every outcome now, the old columns are
  labelled `p50 ok` / `p99 ok`, and the readme carries a bullet on the trap
  plus a note on which column is readable across rows. no-retry 40ms → 0ms all,
  fixed-100ms 229ms → 800ms all, decorrelated 240 → 277, retry-after 56 → 57,
  every other row identical; no previously published number moved and the two
  latency-free conclusions (synchronization, wasted work) are unchanged. p99
  stays success-only on purpose — the "fatter success tail" bullet is a claim
  about successes. 09 computes the same percentiles but records every item's
  latency unconditionally and asserts all-ok, so it has no equivalent defect
  and there was nothing to port. found and fixed 2026-08-28
- [low] 06 — `peakArrivalsPerWindow` bins arrivals by `floor(t / windowMs)`
  rather than sliding a window across them, while its docstring says "largest
  number of arrivals landing inside any single window" — a burst straddling a
  bin edge is split between two counts. checked against a real sliding maximum
  on all eight strategies: only fixed-100ms differs, 69 binned vs 70 sliding,
  so no published number is wrong and the 104-vs-61 comparison the readme
  rests on holds either way. the definition is still not what the docstring
  claims. found 2026-08-28
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
| 14-context-window | 2026-08-30 |
| 13-ann-hnsw | 2026-08-29 |
| 12-groundedness-scoring | 2026-08-29 |
| 11-prompt-caching | 2026-08-29 |
| 10-chunking-strategies | 2026-08-29 |
| 09-concurrency | 2026-08-28 |
| 08-agent-tool-loop | 2026-08-28 |
| 07-near-duplicates | 2026-08-28 |
| 06-rate-limiting | 2026-08-28 |
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

06 came back clean on every algorithm and dirty on how the results were
reported. all five backoff policies match the aws architecture blog term for
term (full jitter draws [0, exp), equal jitter floors at exp/2, decorrelated
draws [base, prev*3) capped and is the only one carrying prev forward, and the
retry loop passes the policy's own delay forward rather than the retry-after
override, so the decorrelated chain stays the policy's); the retry loop is
1-indexed with `retriesUsed = attempt - 1` and stops exactly at maxRetries; the
token bucket refills continuously and is the same class on both sides of the
wire, so server and client cant disagree about what 20 req/s means; the virtual
clock orders timers by (time, seq) and every strategy reruns byte-identical;
`percentile` matches 02's interpolation; and all 8 rows of readme numbers match
`npm start` today. the defect was one level up, in the table itself: the
latency columns silently conditioned on success while success rates spanned
10.5% to 100%, fixed above. one low finding on the peak-window definition came
out of the same read and is listed open.

worth recording as a habit: the wrong number here was not computed wrong, it
was computed over the wrong set. every metric in a comparison table needs its
population named, because the strategy that gives up most is the one a
success-only average flatters most — and that is the strategy the table exists
to warn about.

08 came back clean on the loop and dirty on one column of the pricing table.
the three policies do what the readme says term for term: strict dies on the
first invalid emission (15 of 15 flawed tasks, `validation-error`), feedback
allows exactly `maxFeedbackPerIntent` rounds and gives up on the 7th emission,
the guard fires on the 3rd identical invalid call and so kills the corrector
that needs 3 rounds while sparing the one that needs 2, and the feedback
budget resets per intent rather than per task. the loop guard keys on
canonical (name, args) and counts only invalid emissions, so `dup-calls`
doesn't trip it. every authored `flawedCall` in `tasks.json` is genuinely
rejected by the tool schema it targets and every authored `call` is genuinely
accepted — checked call by call, so no flaw is priced for a call that would
have validated. the run is byte-identical across reruns, the stubborn saving
really is input-side (input 3528 → 570 of the 3210-token total), and every
number in the readme matched `npm start` before the fix. the defect was in the
pairing: the clean twin ran on a seed unrelated to the run it was subtracted
from, so `unknown-tool` published 584ms of extra latency for one extra model
call that costs 600ms at minimum. fixed above. four smaller findings came out
of the same read, one of them a cross-project inconsistency in 11.

worth recording as a habit: a paired comparison that doesn't share its random
draws is a paired comparison in name only. the tell was cheap — an extra model
call priced under the floor of one model call — and it is worth looking for
wherever two runs get subtracted: does the difference have a value the
mechanism could not produce.

10 came back clean on every mechanism and dirty on one sentence. the chunkers
hold their invariants under 4000 random configurations: spans map back to the
source, no word is lost or duplicated at any (size, overlap), no window is
contained in another, and span-arithmetic coverage agrees with substring
containment on every generated answer — so `best_coverage == 1.0` iff the
answer is not split, which is the hinge the whole eval turns on. the sentence
splitter survives 20000 fuzzed documents on all three of its documented
invariants (spans map back, spans never overlap, only whitespace between
consecutive spans) plus a fourth it does not claim but 12 depends on: no
non-whitespace text is ever dropped. it is load-bearing beyond this project —
12-groundedness-scoring imports `split_sentences` rather than rewriting it, so
a boundary bug here would move 12's numbers too. every one of the 40 gold
answers is exactly one splitter sentence, which is what makes "sentence
packing can never split an answer" true by construction rather than by luck.
metrics are 02's, imported: reciprocal rank 1-indexed and cut at 10, hit@k
slicing k, ties broken on chunk id so reruns are byte-identical across
PYTHONHASHSEED. no query or gold text reaches the chunker or the index —
`chunk_corpus` and `BM25Index` see documents only. the ranked list is exactly
10 long for all 40 queries in all 8 configs, so `ctx w@5` always sums 5 chunks
and the cross-config context comparison is like for like. all 10 table rows and
all 11 prose numbers match `main.py` today, verified from a fresh clone.

the defect was in the prose: a stated multiple the sentence's own numbers
refute, and attached to the wrong pair of the two it names. fixed above.
three smaller findings came out of the same read and are listed open.

worth recording as a habit: a magnitude word is a claim and gets checked like
one. "more than doubles", "an order of magnitude", "halves" — divide the two
numbers the sentence already prints. this one was 1.95x, and the pair that did
clear 2x was sitting in the same sentence being called "the same trade", so
the check that catches it is arithmetic on numbers already published, not a
rerun. it is the cheapest review pass in the repo and nothing else had run it.

11 came back clean on the cache model and dirty on one denominator. the
simulated prefix cache matches the published semantics term for term: reads
bill 0.1x, 5m writes 1.25x and 1h writes 2x, a hit is the longest previously
cached prefix reachable from any breakpoint's lookback, writes bill only the
delta past that hit, prefixes under 1024 tokens silently dont cache while a
longer breakpoint in the same request still does, reads refresh the timer with
the entry's own ttl rather than the reading request's, and the 20-block
lookback boundary is pinned at 19-behind-hits / 20-behind-misses. keys are
length-prefixed per block so `["ab","c"]` and `["a","bc"]` cannot collide, and
unicode blocks round-trip. every prospective token is conserved across
strategies (uncached + read + write is the same total for none, static-only
and incremental), which is the invariant the whole cost table rests on. output
is byte-identical across reruns and under PYTHONHASHSEED, and all 24 readme
numbers match `npm start`, verified from a fresh clone. experiments 1, 3, 4
and 5 each baseline against their own events; experiment 2 did not, and that
was the defect, fixed above. three smaller findings came out of the same read
and are listed open, one of them a cross-project label clash with 18.

worth recording as a habit: when one row in a table of ratios is built
differently from its neighbours, that asymmetry is the finding. the four other
experiments here computed a baseline from the same events they were pricing;
the fifth reached for a baseline computed elsewhere in the function, and the
0.002 it cost was too small to notice by reading the number. the check that
catches it is structural, not arithmetic — for every ratio, name the
denominator's population out loud and see whether it is the numerator's.

12 came back clean on the evaluation and dirty on one scorer's input. the AUC
is the mann-whitney statistic done exactly over all 25x35 pairs with ties at
0.5 and it reads in the right direction (P(unsupported below supported), so
sentence_cosine's 0.432 really is worse than chance); the youden sweep tries
every threshold producing a distinct flagging — each unique score plus one
above the max, which is the complete set for a strict `<` rule — and ties go
to the lowest, which flags least; precision, recall and FPR are each computed
over the right population and J is recall minus FPR row by row. evaluation
hygiene holds: the tf-idf index is fitted per context on that context's own
sentences and nothing from the claim set touches the fit, so there is no leak
from the thing being scored into the thing scoring it. the thresholds are
tuned and reported on the same 60 claims, which is the classic
misleading-measurement shape, but the readme names it as such and refuses to
publish an operating point as a setting — disclosed, not claimed. reuse is
real: 02's tokenizer and TfidfIndex and 10's sentence splitter are imported,
not reimplemented. output is byte-identical across reruns and under
PYTHONHASHSEED, and every readme number matched `python main.py` before the
fix. the defect was one layer down, in what counted as a number — `p99` was
being read as the quantity 99 — fixed above. four smaller findings came out of
the same read and are listed open.

worth recording as a habit: the readme was right and the code was wrong. it
said c06-5 scores 0.5 and the program printed 0.667, and the gap sat there
because the review that produced the sentence reasoned about the claim's two
figures while the code reasoned about three regex matches. when prose and
output disagree by a little, the prose is often the honest one — it was
written by someone counting the actual thing. the test made it worse: the
p99 case was written into `test_integers_and_decimals` and its wrong answer
pinned as expected, so the suite defended the bug. an example chosen because
it is tricky needs its expected value derived from the definition, not from
what the code happened to print.

13 came back clean on the algorithm and dirty on a diagnostic. the index is
malkov & yashunin term for term: levels are `floor(-ln(u) / ln(M))` and the
observed distribution matches the theory to a node or two (2812 at level 0
against a predicted 2812.5, 174 against 175.8, 13 against 11.0), the descent
takes one greedy ef=1 step per layer and the layer-0 beam is the paper's
best-first search, the new node selects M neighbors on every layer while
shrink caps at 2M on layer 0 and M above, and selection algorithm 4 is exact
including keep-pruned-connections — keep a candidate only if it is closer to
the new node than to every neighbor already kept, ties keeping. the cost unit
is honest: `_dists` is the only place a distance is computed and it always
increments the counter, so the build number carries the heuristic's own
comparisons and search is reset per sweep row rather than inheriting build.
hygiene holds — queries are fresh draws from the same mixture, nothing from
them touches the graph, and the exact top-10 that defines recall is computed
by a separate index; recall is 02's `recall_at_k`, imported, 1-indexed and
slicing k. every measured number is byte-identical across reruns and under
PYTHONHASHSEED, only the wall-clock columns move and they say so in the
header. every published number, table and prose, matches `python main.py`
from a fresh clone, root readme included.
the defect was in `reachable_on_layer0`, the probe behind the ablation's
"strands 145 of 2000" — it walked from node 0, not from where a search
starts. fixed above. six smaller findings came out of the same read, two of
them shared with 21.

worth recording as a habit: a diagnostic needs its starting point checked the
way a metric needs its population named. this one was measuring reachability
in a directed graph from an arbitrary node, and it agreed with the right
answer on all five published configurations, so nothing in the output looked
wrong — on neighbouring seeds the same code is off by 10x in either
direction. the check that catches it is not arithmetic on the published
number, it is asking what question the code answers and whether that is the
question the sentence quoting it asks. the tell was already in the repo: 21
had written the same probe from the entry point, and two folders computing
one diagnostic differently is the finding whichever one turns out to be
right.

14 came back clean on every mechanism and dirty on two claims in the same
section. luhn is the 1958 algorithm term for term: significance is raw
frequency over the whole text with stopwords dropped, a cluster is a maximal
run whose significant words are never more than maxGap insignificant ones
apart, the score is count^2 over the span from first to last significant word,
and the span counts every word in between including stopwords, which is what
Luhn's own definition says. rarity is textbook idf, mean of ln(N/sf) over the
sentence's unique content words. selection is score descending with ties to
the earlier sentence, emitted in original order, so it is order-stable.
budgets hold: across the two window policies and the six summarize variants at
all four budgets, no assembled context exceeds its budget in any of the 19200
calls that sweep makes, and the
reported token count is the same sum of `estimateTokens` over parts that the
fitting decisions used, so the number and the rule cannot drift apart. hygiene
holds — nothing from a probe reaches the summarizer, the value appears exactly
once per conversation and `validateConversation` asserts it on every generate,
and the probe turn names the key and never the value. the lag buckets and the
fact classes are exactly balanced (40 each way), which is what makes the
by-class columns comparable at all. output is byte-identical across reruns,
and every table line in the readme matches `npm start` character for character
from a fresh clone.

both defects were in "what the numbers mean". the fixed one read a
sentence-scoring mechanism out of a gap its own table contradicts twice; the
open one is a magnitude word that the numbers three lines above it refute, and
it is on the front page as well as in the project.

worth recording as a habit: the by-class columns were the finding, and the
check that catches it is reading the *whole* column, not the row the sentence
quotes. the bullet cited one pair, 89.2 against 82.5, and it is real — but the
same column has a luhn row with the opposite sign and a sliding-window row
with a bigger gap, and both were printed on screen the whole time. a claim of
the form "policies like A do X, policies like B dont" is a claim about every
row, so it gets checked against every row. the second half is arithmetic the
project already had the parts for: 120 probes a side makes a 6.7 point gap
z=1.48, and nothing in this repo had computed a standard error on a retention
percentage before. a percentage with no n beside it is a number you cannot
argue with yet.

14 also had no test tying `main.ts`'s published run to its readme — the
integration file pins its own seed 500 / 5 conversations, not the 20260828 /
20 the readme quotes — so every published number was unpinned. the fix adds
that binding for the numbers it touches, including four derived figures the
entry point never prints. the rest of the readme's numbers are still unpinned;
10 and 12 have the pattern worth copying.

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
- resumable partial-json scanner: scan state carried between fragments, container stack holding references into the value tree under construction, incremental string decode with an escape buffer, number/literal token buffers, poison-once invalid handling; pinned prefix-equivalent to 05's rescan parser, never a rewrite of its semantics (05, typescript)
- live-view vs deep-copy read contract: O(1) view of the live tree with dangling-token splice-and-undo, O(tree) owned snapshot via structuredClone (05, typescript)
- seeded tool-call-shaped json document generator at parameterized size with escapes and non-ascii (05, typescript)
- per-fragment materialization replay harness with chars-scanned work accounting, baseline vs view vs snapshot modes cross-checked on final results (05, typescript)
- virtual-time clock: deterministic (time, schedule-order) timer firing, deadlock detection, run-until-settled driver (06, typescript)
- continuous-refill token bucket: lazy elapsed-time refill, burst cap, exact next-token wait (06, typescript)
- backoff policies: fixed, capped exponential, full jitter, equal jitter, decorrelated jitter (06, typescript)
- bounded retry loop with retry-after compliance and hard failure after max retries (06, typescript)
- client-side pacing limiter: token bucket whose acquire waits instead of failing (06, typescript)
- retry-collision metric: max retries arriving at the same virtual instant (06, typescript)
- simulated hard-outage window: [start, end) instant pre-admission 503s that never drain admission tokens, optional time-to-recovery Retry-After, endMs=Infinity dead service which refuses to advertise (06, typescript)
- server-side Retry-After hint jitter: additive uniform draw on every hint (429 and outage 503) from a dedicated rng so enabling it leaves the seeded latency/fault stream untouched (06, typescript)
- retry-after compliance on 503 as well as 429: max(policy delay, hint) on any failure carrying one (06, typescript)
- outage scenario runner with waste/recovery/drain accounting: attempts during outage, recovery spike per window anchored at the recovery instant, drain time, give-up latency percentiles, peak attempts/s (06, typescript)
- give-up cliff grid: success rate over outage duration x retry policy against the cumulative backoff budget (06, typescript)
- dead-service retry-pressure accounting: per-request budget burn, makespan, peak attempts/s, give-up latency on a service that never recovers (06, typescript)
- inverted-index bm25: posting lists term -> [(doc index, tf)] in ascending doc order, term-at-a-time accumulation ordered exactly like the flat scan so results are bit-identical, pinned by exact-float equality tests (02; the flat BM25Index is unchanged and stays the reference)
- heap top-k selection over score accumulators with (-score, doc id) ordering (02)
- search work accounting: postings touched, candidate count, terms matched, flat-scan work as matched terms x corpus size (02)
- seeded zipf synthetic corpus and query generator: cumulative-weight rank sampler, bounded doc lengths, query strata typical / common-heavy / rare-only (02; terms survive 02's tokenizer unchanged so generated and indexed corpora are the same corpus)
- corpus-size scaling sweep harness: per-size sequential build and measure, wall-clock mean/p95 via 02's percentile, work counts, linear projection (02)
- head-term share: fraction of a query's touched postings owed to its single most common term (02)
- word n-gram shingling with nfkc/casefold normalization and short-text single-shingle fallback (07)
- exact jaccard similarity over shingle sets, empty-empty defined as 1.0 (07)
- minhash signatures: seeded affine hashes mod the mersenne prime 2^61-1, prefix-truncatable, empty-set sentinel (07)
- banded lsh candidate generation with collision s-curve 1-(1-s^r)^b and halfway-threshold placement (07)
- 64-bit simhash fingerprint with per-bit shingle voting + hamming distance (07)
- seeded document mutation family (typos, word drops, sentence shuffle, truncation, case/whitespace noise) with provenance-based duplicate labels (07)
- pair-level precision/recall/f1 against labeled duplicate pairs (07)
- agent tool loop with hard edges: model-call budget, per-intent validation-feedback cap, identical-invalid-call loop guard (08, typescript)
- zod issue-signature guard key: tool name + sorted issue path:code pairs, values/messages/unrecognized-key-names excluded, unknown tools keyed by name; loop-guard trip limit as a policy knob (08, typescript)
- drifting flawed-call scripts: per-feedback-round malformed-call sequences with clamp-at-last, pure function of the visible history (08, typescript)
- guard-limit sweep with corrector-kill accounting (completions a guard costs vs the burn it caps) (08, typescript)
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
- content-token overlap precision: unique claim tokens found in context over claim tokens, stopword-filtered (12)
- per-sentence max tf-idf cosine grounding score: 02's TfidfIndex fitted per context on its own sentences, claim scored against the best one (12)
- numeric consistency gate: digit-literal extraction with thousands-separator joining, fraction of claim numbers present anywhere in context, claims with no numbers pass (12)
- negation-parity heuristic: fixed cue list, hard zero when claim and best-matching sentence disagree on negation presence (12)
- exact pairwise ROC-AUC over supported x unsupported score pairs, ties at half credit (12)
- Youden's J (recall minus false positive rate) threshold sweep, tie to the lowest threshold (12; 07's f1 sweep picks a hamming radius, this picks a score cutoff where flag-everything scores zero)
- authored hallucination taxonomy dataset: minimal-edit unsupported claims (entity swap, number swap, negation flip, antonym/transposition flip) plus fabrications and outside-knowledge truths, with paraphrase / synthesis / negated-paraphrase supported traps (12)
- exact flat nearest-neighbor index: one vectorized squared-L2 scan per query, (distance, id) tie-break, distance-computation accounting (13)
- hnsw graph index: geometric level assignment, layered greedy descent, best-first beam search of width ef, bidirectional links with degree caps and re-selection shrink (13)
- hnsw neighbor-selection heuristic (keep a candidate only if closer to the query than to every kept neighbor) with fill-from-discarded, plus a naive M-closest mode for the ablation (13)
- layer-0 reachability count as a graph-integrity metric (13)
- seeded gaussian-mixture and uniform synthetic vector datasets with uniform outlier queries (13)
- ann recall@k: 02's recall_at_k with the exact top-k as the relevant set (13 imports 02's metric rather than rewriting it)
- context-budget eviction policies: full history, sliding window over whole recent turns, head-and-tail pinning, summarize-evicted with a reserved summary share; pinned system/current turn, over-budget flag, per-part token accounting (14, typescript)
- luhn extractive summarization: frequency-significant words, cluster score significant^2/span with a max-gap cap (14, typescript)
- rarity sentence salience: mean ln(N/sentence-frequency) over a sentence's unique content words (14, typescript; idf-shaped like 02's idf but over sentences within one text, built to rank one-off decisions above repeated chatter)
- budget-packed sentence selection: rank by salience, greedy fill of a token budget skipping oversized sentences, emit in original order (14, typescript)
- unicode-aware word tokenizer with hyphen/underscore compounds and a stopword list (14, typescript; \p{L}\p{N} word characters, deliberately avoiding the ascii-boundary defect recorded as an open 03 finding)
- terminator-run sentence splitter with whitespace lookahead so decimals do not split (14, typescript; 10's python splitter carries the abbreviation guard, this one serves generated text)
- seeded planted-fact conversation generator: single-occurrence nonce values, standalone vs buried fact classes, lag-bucketed probes that ask by key, generation-time single-occurrence validation (14, typescript)
- fact-retention metric: value-substring presence in the assembled context at probe time, split by lag bucket and fact class (14, typescript)
- symmetric per-vector int8 quantization: max-abs/127 scale per vector, zero-vector guard (15)
- asymmetric per-dimension uniform grid quantization at parameterized levels (int8 at 256, int4 at 16): min/max or quantile fit, constant-dimension guard, out-of-grid edge clipping (15)
- int4 nibble packing, two codes per byte with odd-tail padding (15)
- quantized-store search as float search over the dequantized reconstruction (asymmetric distance, float queries) through 13's unchanged indexes (15)
- float rerank recovery: quantized top-C candidates, full-precision rerank to top-k with (distance, id) ordering and duplicate collapse (15)
- per-scheme memory accounting in exact bytes: codes plus float32 per-vector scales or per-dimension grid params (15)
- rmse reconstruction error between original and dequantized matrices (15)
- authored quantization failure injections: near-constant rogue dimension, rogue outlier rows (15)
- scripted latent-utility judge family: quality weight, per-call gaussian noise, position bonus, ln-length verbosity term, provenance self bonus, pointwise pass threshold (16, typescript)
- fnv1a string hash deriving per-call mulberry32 streams so a verdict is deterministic per (judge, item, presentation order) (16, typescript; box-muller gaussian on 05's prng)
- pointwise pass/fail and pairwise forced-choice eval modes over one judge cast (16, typescript)
- presentation-order protocols: as-stored, seeded randomized shared across judges, both-order with abstain on self-disagreement (16, typescript)
- cohen's kappa: two-class chance-corrected agreement from rater marginals, constant-rater case defined 0 (16, typescript)
- flip-rate position-bias diagnostic and decided/coverage/effective-accuracy accounting for abstentions (16, typescript)
- attribute-balanced pair-set construction: stored order, provenance and length each exactly uncorrelated with gold labels (16, typescript; 10's and 12's authored-dataset discipline applied to bias probes)
- win-rate-vs-known-truth bias probes: champion-first suppression, house self-preference inflation, longer-answer win rate (16, typescript)
- per-protocol judge-call token and cost accounting over rubric plus question plus answers (16, typescript; prices 08's estimator)
- multinomial softmax regression: zero-init deterministic full-batch gradient descent, l2 on weights only, continuable fit (17)
- bag-of-words count vectorizer over a train-only vocabulary, unknown tokens dropped (17; tokenization is 02's tokenizer imported, not rewritten)
- stable softmax and log-softmax with row-max shift (17)
- reliability table over max-softmax confidence: equal-width bins, confidence exactly 1.0 in the last bin, per-bin count / mean confidence / accuracy / gap (17)
- expected calibration error (count-weighted) and maximum calibration error (worst bin) (17)
- multiclass brier score against one-hot labels (17)
- temperature scaling: single scalar fitted by golden-section search over inverse temperature, exact by convexity, argmax-preserving (17)
- selective auto-answer policy metrics: coverage and accuracy-among-answered at a confidence threshold (17)
- seeded phrase-bank intent-ticket generator with a per-slot intent-borrow ambiguity rate and a drifted variant (raised borrow rate, filler vocabulary unseen at training) (17; 11's and 14's phrase-bank discipline in python)
- hashed lexical feature embeddings: word unigram+bigram and boundary-marked character trigram sparse vectors via the hashing trick, fnv1a mod 2^20, l2-normalized (18, typescript; fnv1a imported from 16)
- cosine similarity as a sparse dot product over the smaller of two normalized maps (18, typescript; 02's tf-idf cosine is dense python over raw tf, this is hashed-feature typescript — kept behaviorally separate on purpose)
- text normalization to a canonical cache key: lowercase, unicode letter/digit runs, single spaces (18, typescript)
- two-layer semantic response cache: exact-match map on the normalized key plus nearest-neighbor cosine serve at a threshold, earliest-entry tie-break, one entry per normalized key, no eviction (18, typescript)
- pair-class similarity analysis: authored trivial/paraphrase/near-miss/unrelated pair sets with per-class stats and a threshold operating table (recall per same-intent class, fpr on near-miss pairs) (18, typescript)
- inversion rate: fraction of (same-intent paraphrase pair, cross-intent near-miss pair) comparisons where the near-miss scores higher (18, typescript; 12's pairwise roc-auc statistic re-expressed as 1-auc over two authored pair sets — not a port of 12's implementation)
- seeded zipf popularity sampler over a shuffled item list (18, typescript)
- surface-noise traffic ops: greeting/tail filler wrapping and seeded adjacent-letter typo injection with a changed-text flag (18, typescript)
- cache replay cost/risk accounting: priced misses vs counted wrong-intent serves, savings vs no-cache and exact-only baselines, wrong answers per 1k requests (18, typescript; prices 08's estimator like 16)
- templated golden-set builder: six task categories with authored distractor answers and per-item difficulty offsets, committed file pinned equal to the builder output (19)
- scripted bernoulli model versions: per-category skill tables, outcome deterministic per (version, item id, eval seed) via sha256-derived seeds (19)
- persisted eval run record: dataset sha256 fingerprint, per-item outcomes, load-time self-consistency recompute rejecting tampered artifacts (19)
- paired run comparison with flip table (both-correct/both-wrong/fixed/broken) and per-category deltas (19; the aggregate and per-slice intervals are 02's paired_bootstrap imported, not rewritten)
- regression gate policies: naive accuracy-drop threshold, aggregate bootstrap-ci gate, per-slice ci gate with its multiple-comparison exposure, combined gate (19)
- gate error-rate measurement against authored ground truth: false-alarm and detection rates over seeded rerun pairs (19)
- ci-gate detection power curve vs eval set size over template-generated golden sets (19)
- luhn checksum validation over a digit string, single-digit corruption flips validity (20, typescript)
- empirical shannon entropy in bits per char over a string's own char frequencies (20, typescript)
- rule-based pii span detection: regex candidates behind validators (luhn + brand prefix for cards, entropy gate + known prefixes for secrets, ssn field ranges, formatted-phone-only, ipv4 octet bounds), exact [start,end) char spans (20, typescript)
- greedy span overlap resolution: earliest start, then longest, then fixed type priority (20, typescript)
- typed-placeholder pii redaction, same literal value maps to one stable placeholder within a call (20, typescript)
- de-obfuscation normalization for matching: nfkc, zero-width strip, cyrillic/greek homoglyph fold, in-word-only leetspeak fold, letter-spacing collapse of runs of 4+ (20, typescript)
- weighted-rule prompt-injection scoring: override/exfiltration/hijack/smuggling/encoding regex rules, score is the distinct-weight sum, each rule counts once (20, typescript)
- base64 decode-and-rescan: printable-decode candidate blobs and run the injection rules over the plaintext, with an encoding-payload marker rule (20, typescript)
- exact roc-auc via the mann-whitney statistic with half-credit ties (20, typescript; 12 has the python pairwise version, 18's inversionRate is the strict-greater 1-auc over two authored pair classes with ties defined 0 and empty defined 0 — this one is the general two-array metric with half-credit ties and empty defined 0.5, kept behaviorally separate on purpose like 18's cosine vs 02's)
- threshold sweep producing precision/recall/fpr points over the union of observed scores (20, typescript)
- layered guardrail pipeline: input injection-score gate, scripted canary-carrying model, output canary substring check then pii redaction, with defense-in-depth accounting (20, typescript)
- scripted canary-leak model: system prompt carries a canary token, verbatim leaks echo it, paraphrase leaks restate the setup and never emit it (20, typescript; the scripted-model discipline of 08/16, here built so a substring output filter is blind to the paraphrase leak by construction)
- authored pii corpus with inline ⟦TYPE⟧ gold-span markers parsed to exact offsets, luhn-fail and low-entropy hard negatives (20, typescript)
- authored injection prompt set with per-attack scripted compliance/leak-style labels and obfuscation-category tags (20, typescript)
- binary vector-store file format: length-prefixed sections (json header, raw float64 vectors, u32-framed per-layer link lists), sha256 trailer verified before parsing, atomic temp-write-fsync-rename save (21)
- full-state hnsw serialization with validating restore: parameters, vectors, links, entry, tombstones, distance counter, and the rng state so growth after load equals growth without a save (21)
- tombstone deletion over hnsw with over-fetch-and-filter live search: fetch an ef-wide result set, drop dead nodes, keep k (21)
- batch hard unlink: strip a node set's edges graph-wide in one pass, reassign the entry to the highest-level live node (21)
- compaction rebuild from live vectors with old-to-new id mapping (21)
- exact-over-live ground truth scan with (distance, id) ordering, uncounted (21; 13's ExactIndex semantics restricted to the live subset of a mutable store)
- live reachability from the entry point over layer-0 links (21; 13's reachable_on_layer0 counts from node 0 over all nodes, this one follows routing from the entry and counts live nodes only)
- hub-targeted delete attack: remove live nodes by descending layer-0 degree (21)
- insertion-order recall variance over seeded shuffled builds (21)
- compaction break-even accounting: rebuild cost divided by per-query distance-computation saving (21)
- sse server-side event serialization with drain-aware sink writes (22, typescript; the producer half of 05's parser, roundtrip-pinned against it byte for byte)
- bounded-queue streaming pipeline between a generator and a sink with per-stream event/byte accounting (22, typescript; 05's AsyncQueue placed between model output and the socket)
- http rag endpoint with strict input validation and a per-request token/cost log split system/question/context (22, typescript; prices 08's estimator)
- extractive scripted reader: best context sentence by question-content-word fraction with a hard refusal floor (22, typescript; 12's content-token overlap idea used as a generation policy rather than a metric, on 14's splitter and stopwords)
- live-endpoint golden-set eval with miss attribution (retrieval miss vs wrong sentence vs refusal) and per-category accuracy (22, typescript; containment scoring over 10's golden queries through real http)
- first-token byte fraction: client re-encodes parsed events with the server's serializer so the streaming payoff is exact wire bytes, not chunk timing (22, typescript; 05's field-availability shape at whole-response level)
- slow-client backpressure harness: sink write blocks one macrotask, queue high-water and stalled pushes as the evidence (22, typescript)
- iterative two-hop retrieval: retrieve, extract, requery, round-robin rank interleave with first-position dedup (23)
- tf*idf novel-term bridge extraction, the pseudo-relevance-feedback move with question-term exclusion (23)
- oracle-bridge ablation isolating extraction quality from hop-2 ranking (23)
- three-bucket hop-1 drift accounting: gold top doc / answer-doc leak / true drift (23)
- pair-recall@k over multi-doc gold sets (23)
- json leaf flattening with concrete and generic (index-collapsed) paths (24, typescript)
- field-level extraction scoring: gold leaves correct/wrong/missing, predicted leaves correct/wrong/spurious, precision over predicted, recall over gold (24, typescript; 07's pair-level p/r/f1 grades labeled duplicate pairs, this grades json leaves against a gold tree)
- value-normalization ladder for leaf comparison: strict, nfkc/casefold/whitespace text fold, currency/thousands-separator numeric parse with tolerance, multi-format date parse to iso refusing ambiguous slash dates (24, typescript)
- greedy order-insensitive array alignment scored by per-pair field f1, deterministic (score, gold idx, pred idx) tie-break, unmatched elements charged whole (24, typescript)
- per-generic-path tally tables and macro f1 over gold paths (24, typescript)
- strict deep-equal exact-match record accuracy (24, typescript)
- seeded structured-record flaw family: format drift, leaf dropping, field hallucination, array shuffle, truncation, typed value corruption, single-field bungling (24, typescript; 07's mutation family damages text documents, this one damages json records)
- authored hypothetical-answer dataset: one answer per golden query, written from the question text alone, standing in for hyde generation (25)
- scripted hyde generator with a nested seeded hallucination knob: per-query sha256 unit draw against the rate, the wrong answer fixed as the next sorted query id (25)
- hyde query rewriting, append vs replace search-string modes over an unchanged lexical index (25)
- prf one-hop query expansion with unmatchable-query fallback (25; 23's extract_bridge_terms imported and pointed at a one-hop query, not a rewrite)
- generic-filler control arm: fluent no-knowledge answer appended to every query (25)
- expansion-size accounting: distinct search-string terms beyond the raw query (25)
- delta-rr conditioning on whether the prf expansion doc was a gold doc (25)

## OPEN THREADS

- 01: the failure distribution is hand-built — what do the same three strategies score against a real model's actual failure modes and rates?
- 01: retries multiply tail latency up to 1+max_retries — where is the cost/latency crossover against constrained decoding or native structured-output modes?
- 02: would stemming help or hurt on this dataset? it fixes "password"/"passwords" but brings its own errors — 03 has a stemmer, a controlled before/after on 02's golden set is still unmeasured
- 02: wand and max-score prune postings that cannot reach the top k and stay exact — how much of the measured common-heavy bill (68765 postings/query) do they skip at top-10, and where does the bound stop paying?
- 02: posting lists are python lists of tuples — delta-encoded varint-compressed postings are the real memory story at scale, and the per-query decode cost is the unpriced tradeoff
- 02: a typical zipf query builds a score accumulator over 84% of the corpus, so per-query memory scales with df too — accumulator capping trades recall for memory and the damage is measurable in this harness
- 02: one added doc appends to postings but moves df and avg doc length, silently re-pricing every idf — at what update rate does rebuild-vs-patch flip, and is that the case for immutable segments with background merges? (same shape as 03's stale-latent-space and 04's incremental-trainer threads)
- 02: how many queries until the bm25 vs tf-idf interval excludes zero, assuming the measured per-query win rate holds? answerable by simulation (19 measured this curve's shape for accuracy evals — 23.3%/46.7%/93.3% detection at 240/960/3840 items — but the mrr version on 02's own golden set is still unrun)
- 02: significance is not importance — what mrr delta actually changes downstream behavior? needs a task-level metric on top of retrieval, not more resamples
- 03: best alpha 0.2 was called "reading tea leaves" on 40 queries — 02 now has the paired bootstrap machinery to answer it, still unapplied to the fusion sweep
- 03: corpus-fit lsa cannot be out-of-vocabulary, so the keyword failure mode of pretrained embedders is unmeasured here — needs a real embedding model on the same golden set
- 03: svd refit is the whole update story — what does incremental indexing look like, and what does a stale latent space actually cost, measured?
- 04: how far are the learned merges from a production tokenizer's on identical text — fertility head to head needs a real pretrained vocab run over this corpus, my 990 merges vs their 100k
- 04: compression is not quality — a bigger vocab is cheaper per request, but whether it helps or hurts a downstream model is invisible without a model
- 04: at what corpus size does naive full-recount bpe training fall over, and what does an incremental pair-count trainer buy, measured — same shape as the full-scan-vs-inverted-index question 02's scaling study answered on 2026-08-30
- 04: crowding is already measurable at two domains (prose 2.94 → 2.80 at matched vocab to buy 41.8% on code, fixed 2026-08-27) — the open shape is the curve as domains multiply, and whether there is a budget past which a new domain stops paying for itself
- 04: script cost is measured per line and the emoji line is diluted by the english around it — a per-codepoint-class breakdown would price each script honestly

- 05: queue capacity is counted in chunks — a byte-budgeted queue is what a real memory ceiling wants, and chunk sizes varying 1000x would break the chunk-count story
- 05: the sse parser buffers an unbounded line if the stream never sends a terminator — needs a cap and a deliberate failure mode
- 05: the resumable scanner's snapshot() deep-copies the whole tree per call, quadratic again if taken per fragment; a persistent-structure snapshot (path copying, shared unchanged children) would be O(depth) per fragment, and its cost to push() and the crossover against structuredClone are unmeasured
- 05: the resumable scanner reads decoded strings, so 22's pipeline still pays a TextDecoder pass between the sse layer and this one; a scanner over raw utf-8 bytes would fuse those layers, and whether fused beats decoder-plus-scanner is unmeasured
- 05: view() per fragment is ~0.8us, so the next real-client bottleneck is the consumer reacting to every fragment; dirty-path tracking (which paths changed since the last view) would let a ui re-render only what moved, at an unmeasured bookkeeping cost per push
- 05: the stream is scripted and the chunker is uniform 1..24 bytes — real networks burst; replaying a captured real provider stream (timings included) would make the ttft and availability numbers mean something outside the fixture

- 06: the herd is one-shot at t=0 — a poisson arrival process with a congestion spike in the middle would test whether the strategy ordering survives steady-state traffic
- 06: full jitter and decorrelated fail 2 and 7 of 200 requests where equal jitter fails 0 — is the delay floor the real variable? a floor sweep (0%, 25%, 50% of exp) at fixed retry budget would isolate it (the outage extension sharpened this: at a 10s outage the floor is worth 32.5 points of survival, equal jitter 100% vs full jitter 67.5%)
- 06: pacing is measured at exactly the server rate — a rate sweep (80%..120% of server rate) would find the throughput/429 knee, and adaptive pacing (aimd on 429s) is the real-world answer when the server rate is unknown
- 06: 503 retries bypass the pacing bucket by design and cause every leftover 429 — routing retries through the pacer (and measuring the makespan cost of that fairness) is a one-line change with a real trade-off attached
- 06: the virtual clock fires timers one at a time with a full continuation flush between — at what simulated scale does that become the bottleneck, and what does batching same-instant timers buy?
- 06: the dead-service study prices the missing circuit breaker — trip after k consecutive failures with a half-open probe collapses the 1080-attempt bill to roughly the trip threshold per client, at a false-trip cost during survivable spikes like the main herd; both sides are measurable in this harness
- 06: recovery is instant full capacity — a ramped recovery (server advertises a reduced rate for the first seconds) vs client-side spreading of the recovery herd is a which-side-of-the-wire question, unmeasured
- 06: a deadline budget (give up at a wall-clock deadline, not an attempt count) would decouple caller hang time from backoff shape; its success cost against these same outages is unmeasured
- 06: hint jitter is in milliseconds while real Retry-After headers quantize to whole seconds, and quantization is itself a synchronizer — how much of the measured desynchronization survives 1s granularity?

- 07: the s-curve was placed knowing the duplicate floor (0.280), which real pipelines never know — what does adaptive band/row selection from sampled candidate similarities look like?
- 07: multi-probe lsh claims recall without more tables — how much of the mistuned banding's 0.086 recall gap does probing buy back, at what probe cost?
- 07: simhash used unit weights per shingle; the original paper weights by importance — does idf weighting pull the overlapping dup/non-dup hamming tails apart enough to close the f1 gap?
- 07: band buckets are exact tuples in dicts — at scale the tables are the memory problem, and hot buckets from boilerplate shingles blow up candidate counts; bucket-size distributions are unmeasured here
- 07: exact-jaccard verification reuses shingle sets already in memory — in a store where fetching originals costs io, when is a k=512 signature verdict cheaper than the fetch, and at what false-verdict rate?

- 08: per-flaw rates and correction curves are authored here — what does a real model actually do on these same tool schemas, and does the 1-round recovery assumption survive contact?
- 08: the limit-4 verdict spares the slow correctors by construction (they correct after exactly 3 rounds) — with correction times drawn from a distribution the sweep becomes a survival analysis and the right limit a quantile of it, which needs real correction-rate data
- 08: the rotate-3 drifter beats both guard keys, and a per-intent wasted-budget cap is just a tighter feedback cap renamed — is there any per-call key short of a convergence measure that separates rotation from progress?
- 08: the issue signature collapses discriminated-union branches that share paths and codes — none of these tools have that shape, so the misfire is unmeasured
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

- 12: run the same 60 claims through a real encoder or NLI model and see which categories actually move; same missing piece as 03's pretrained-embedder thread, now with a labeled taxonomy waiting for it
- 12: the numeric gate scores a fraction where one unverifiable number should be enough; the AND version false-flags legitimate rounding ("about 45 minutes" vs 43), so the real design problem is the tolerance policy
- 12: claims arrive pre-split here; real answers are multi-sentence, and what claim-splitting errors (10's splitter is the obvious tool) do to a per-answer groundedness score is unmeasured
- 12: entity swaps are the biggest unguarded class (0/7 at tuned thresholds); a capitalized-token/name gate shaped like the numeric gate might close it, at an unknown false positive cost on paraphrases that drop titles

- 13: ef=160 nearly doubles cost over ef=80 for the last 0.001 of recall — an adaptive ef that stops when the beam stops improving is the obvious next build
- 13: the whole grid on real embeddings over 02's corpus would say whether the clustered or the uniform column is closer to the truth — same missing piece as 03's and 12's pretrained-embedder threads

- 14: the summarize policy recomputes from all evicted turns every call, an upper bound; an incremental running summary that can never revisit what it discarded is the production shape, and what the irreversibility costs in retention is unmeasured
- 14: probes never restate values here, but real conversations re-mention decisions, which refreshes them into any recency window — how much of rarity-summarization's 57.5%-vs-23.8% long-lag edge survives a workload with re-mention?
- 14: the buried-fact tax (82.5% vs 89.2%) comes from mean-based sentence scoring; max-token-rarity or clause-span scoring might close it, at an unknown cost in long sentences flooding the summary
- 14: retention is binary substring presence; a scripted answerer over these assembled contexts (08's pattern) would price a missing fact in wrong answers rather than percentage points
- 14: 30 exchanges and budgets 400-3200 never saturate rarity-50%'s summary block; the 200-exchange support-thread regime where even the best extractive summary must start dropping facts is the interesting one
- 14: rarity salience wins partly because nonce values are maximally rare by construction; on real transcripts where decisions use words the conversation keeps repeating, the luhn/rarity gap should narrow — needs a real transcript corpus

- 15: int8 costs ~1.5 recall points and 13 showed ef 80→320 buys 0.5 points for 6x the distance budget — per byte of RAM at a fixed recall target, which knob is cheaper, on one shared sweep
- 15: the quantile clip fraction has a cliff on each side (too small keeps the rogue stretch, too large clips real data); an adaptive rule from the observed per-dim histogram is the production question
- 15: product quantization (subvector codebooks via k-means) is the standard next step past scalar; its extra recall per bit on these exact datasets is unmeasured
- 15: hnsw built on floats then searched on codes (or the reverse) would split the flat +0.015 gap into build damage vs search damage
- 15: real embeddings over 02's corpus would test the rogue-dimension story against an actual model instead of an authored constant — same missing piece as 03's, 12's, and 13's pretrained-embedder threads

- 16: flip rate conflates position bias with noise, two coin-flip calls disagree half the time with zero position preference; a net directional statistic (how often the winner follows the presentation slot) would separate them, and the harness holds the ground truth to validate it against
- 16: champion-first suppression (0.500 true → 0.380 measured) is one point on a curve; sweeping the position bonus against the gap distribution would map when an arrangement bias flips a real a/b verdict
- 16: position bias is a constant per judge here; real models show primacy on some prompt shapes and recency on others, and whether the flip diagnostic still localizes damage under a varying bias is untested
- 16: at what abstention rate does a third tiebreak call beat half-credit settlement, given the third call carries the same bias as the first two?
- 16: the 0.600 house inflation sits on 100 pairs; 02's paired bootstrap machinery applies directly and was not run
- 16: the real-model version: same harness, same balanced sets, actual api judges — the one measurement this project deliberately does not claim

- 17: the miscalibration here comes from overfitting, one specific mechanism — an llm's token logprobs or self-reported confidence numbers miscalibrate differently, and the same harness over real api logprobs is the next measurement
- 17: one global temperature is the coarsest knob; per-class temperature, platt scaling with a bias, or histogram binning would show what the residual 0.030 ece is made of and what each extra parameter buys
- 17: the shift experiment shows the fitted T goes stale but not when — an online refit over a sliding window of labeled outcomes has a lag/variance tradeoff worth measuring
- 17: ece on 1200 items carries unquantified sampling noise; 02's paired bootstrap applies directly to the ece delta and the policy table rows and was not run
- 17: max softmax is one of three cheap trust signals — margin (top1 minus top2) and entropy might rank mistakes differently, measurable on this exact data with no new code beyond the signals

- 18: the real-embedder version — precomputed neural embeddings committed for the same dataset and sweep; does paraphrase recall finally separate from near-miss fpr, and does the 99.2% inversion rate drop below coin flip? the whole verdict on semantic caching hangs on that curve, and lexical features cannot draw it (same missing piece as 03's, 12's, 13's, 15's pretrained-embedder threads, now with a labeled trap dataset waiting)
- 18: wrong serves are non-monotone in the threshold (char 44 at 0.50 vs 85 at 0.70) because higher thresholds admit more entries and every stored sibling is a later near-miss chance — is there a store-admission policy that restores monotonicity so pair statistics predict pipeline behavior?
- 18: a serve-margin rule (best minus second-best similarity must clear a gap) might refuse exactly the near-miss serves, since family siblings crowd each other in the store — unmeasured
- 18: no ttl and no staleness: replay traffic where some intents' answers change mid-stream and price a stale serve against a wrong-intent serve
- 18: lookup is a linear scan; wiring 13's hnsw (and 15's quantized store) under the cache is the scale composition the repo is already holding the parts for
- 18: the zipf exponent decides how much exact matching already captures — at what popularity skew does the semantic layer's marginal saving stop paying for its risk?

- 19: multiple-comparison correction (bonferroni or benjamini-hochberg) for the slice gate — what does fixing the 16.0% false-alarm rate cost the 68.0% masked-regression detection, on this exact setup?
- 19: gates judge one candidate run; averaging k reruns shrinks noise by sqrt(k) at k times the eval cost — the cost-optimal mix of reruns vs items for a target power is unmeasured
- 19: noise is independent bernoulli per item; a shared per-run skill wobble would correlate outcomes across items and test whether the bootstrap interval still covers
- 19: the flip table (24 fixed / 34 broken under a flat aggregate) is computed but never gated on — a churn gate might catch behavior swaps the mean hides, at an unknown false-alarm price
- 19: the ci gate asks "did it regress at all" while shipping wants a non-inferiority margin (fail iff ci hi < -margin) — the margin sweep reshapes every rate in the table

- 20: the residual undetected leak is a paraphrased system prompt with no shared tokens — a semantic output check (embed the response, compare against the system prompt) is the obvious next layer, and it needs a real embedder, same missing piece as 03/12/13/15/18's pretrained-embedder threads; does it catch the paraphrase without flagging every benign answer that mentions the assistant's role?
- 20: the injection score is a hand-weighted rule sum — 17's softmax regression could learn the weights over the rule-hit vectors, but on 26 authored prompts it would overfit; how many labeled prompts before learned weights beat hand-tuned ones on held-out attacks?
- 20: de-obfuscation is a single fixed pass — nested encodings (base64 inside rot13 inside spacing) beat one pass, and iterating to a fixed point invites a decompression-bomb cost; what is the safe iteration cap and does a real attack corpus need more than one pass?
- 20: exact-span pii scoring charges a near-miss (right value, one extra trailing char) as a full miss — a partial-credit overlap metric (iou over char spans, like object detection) would price close-but-inexact detectors and might reorder them
- 20: the entropy gate is one global threshold and real secrets overlap real prose near the boundary (a git sha is high entropy and not a secret) — a threshold sweep would map the false-positive floor, same shape as 12's youden sweep but over an entropy axis
- 20: pii detection is scoped to formatted us-style identifiers and an authored corpus — international phone/id formats, obfuscated pii, and numbers split across a sentence are all unmeasured, and precision 1.000 only means the detectors handle the cases the corpus author thought of

- 21: unlink-with-repair — reconnect each removed node's in-neighbors to its out-neighbors (the standard patch) and re-run the hub attack on the naive-built graph; how much of the 0.638 reachability collapse does local repair buy back, at what edge-update cost?
- 21: the tombstone cost story used a fixed ef=80 — a search that terminates once it holds k live results would show the true over-fetch curve, and where a 70%-dead store forces the beam wide
- 21: append-only persistence — a snapshot plus a replayed add/delete log; at what mutation rate does replay-on-load beat rewriting the snapshot, and what does the log cost at query time?
- 21: the compaction break-even treats the store as frozen while queries arrive — with continuous inserts and deletes it becomes a scheduling policy, the same shape as lsm compaction, unmeasured
- 21: per-query cost is non-monotone in index size at fixed ef (212.7 dists at 1000 vectors vs 244.4 at 600) — mapping the ef-vs-n cost surface would say when shrinking the store stops paying at fixed beam width

- 22: a real model behind the same harness — does answer accuracy finally track hit@k once extraction stops being lexical, and is a better reader or a better retriever the cheaper fix for the 0.200 paraphrase column
- 22: compose 11's prefix cache into the request path — system prompt and doc renderings are stable prefixes, so what does the k sweep's cost column become with cache-billed tokens
- 22: sweep the 0.35 refusal floor and draw the operating curve (refusals-with-gold against answered-without-gold) — 12's and 20's roc machinery applies as is
- 22: the streaming queue caps events, not bytes — 05's byte-budgeted-capacity thread now has a server attached where it would actually bind
- 22: put the endpoint under a request herd with 06's limiter and 09's pools composed in front, and check whether per-request cost logging stays accounting-clean under concurrency

- 23: drift cost nothing because the trap doc was a vocabulary island (its distinctive terms have df=1 and point only back at itself) — a corpus with topic clusters, several tuning guides sharing jargon, should make a poisoned hop 2 actively harmful instead of an echo; that dataset is the missing measurement
- 23: the merge is a fixed hop1-first interleave, which pins two-hop recall@1 at 0.083 for every system including the oracle — re-scoring the merged pool or leading with hop 2 on a confident extraction attacks that floor, but needs an extraction-confidence signal first
- 23: the tf*idf margin between the top novel term and the runner-up looks like a router signal for when to spend the second search — would it have skipped the 8 controls (2.00x cost, zero gain) and the t01 tuning-guide trap?
- 23: hop 2 conditions on exactly one doc, hop 1's top — extracting from the top 3 docs and merging term sets hedges the wrong-top-doc failure at the cost of more drift surface, unmeasured
- 23: dense hop-1 retrieval under the same harness would test whether bridge-extraction misses drop or just move to paraphrased bridges — same pretrained-embedder thread as 03/12/13/15/18/20

- 24: alignment and scoring share one normalization config — on messier arrays a pair could align differently under L0 than L3; should alignment always run at the most forgiving level while scoring runs at the chosen one?
- 24: leaf comparison is all-or-nothing — "Acme Industrial" vs "Acme Industrial Supply" scores 0; token-level partial credit inside a leaf is 20's span-iou thread one level down
- 24: all leaves weigh 1, so a wrong tax equals a wrong tote-bag description — field weights fix the paging story and immediately raise who sets them and how
- 24: macro over gold paths is blind to hallucinated structure (hallucinator macro 0.947 > its micro 0.799) and union-macro is undefined on recall — the missing third summary number is something like a hallucinated-structure rate per record
- 24: numeric parsing is us-locale — indian grouping 12,34,567 and european decimal-comma 4.800,00 are refused by design; locale-aware parsing is the production gap
- 24: a real model in json mode over these 12 documents rendered as text would say which authored flaw class actual extractors favor — same missing piece as 01's real-failure-modes thread

- 25: a real model writing hypotheticals for these same 40 queries — where between 0.983 (knowledgeable) and 0.560 (fluent ignorance) does it land, and what hallucination rate does it actually exhibit on questions this ordinary; same missing piece as 01's real-failure-modes thread
- 25: hallucination here is total, the answer to a different question entirely — a graded wrongness knob (right topic, wrong details, mostly on-topic vocabulary) should degrade append far more gently than the swap measured here, and is the more realistic failure
- 25: append weights query and answer equally because bm25 counts each distinct term once — score-level interpolation between a raw-query search and a hypothetical-only search (03's fusion machinery applies as is) might keep the anchor while shrinking honest-answer regressions like p07's 1.000 → 0.333
- 25: prf had nothing to do because 32 of 40 first-search top docs were already gold — whether multi-doc extraction or a deliberately weakened first-pass retriever gives it room to act is unmeasured (23's multi-doc extraction thread, one hop down)
- 25: real hyde samples several hypotheticals and pools them — whether three authored paraphrases of one answer beat one, or just widen the drift surface, is testable in this harness at the cost of more authoring

## BLOCKED

(empty)
