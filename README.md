# AI Learning Projects

I'm a software engineer working my way toward applied AI engineering. This
repo is where that happens: one small project at a time, each one rebuilding
a concept I've been using through libraries until I actually understand it.

The rules I'm holding myself to:

- Every project is built from scratch with plain code — no copying model
  glue from tutorials, no letting an LLM write the core logic for me.
- Every project has real tests and some kind of evaluation, because "it
  looks right" is how I've fooled myself before.
- Every README is honest about what went wrong, not just what worked.

Projects build on each other where it makes sense — 03 exists because of
the two paraphrase queries 02 couldn't answer. [progress.md](progress.md)
tracks what's done, which mechanisms already exist in the repo (so nothing
gets rebuilt twice by accident), and the open questions each project left
behind — those open questions are where the next projects come from.

## Projects

| # | Project | Concept | One-line takeaway |
|---|---------|---------|-------------------|
| 12 | [groundedness-scoring](12-groundedness-scoring/) | Lexical groundedness scoring — flagging RAG answer claims the context doesn't support, measured per hallucination category (Python) | Surface similarity ranks hallucinations above the truth: on minimal-edit hallucinations, tf-idf sentence cosine gives unsupported claims a *higher* mean score than supported ones (0.762 vs 0.668, AUC 0.432) because a swapped entity keeps a sentence's words while an honest paraphrase loses them; a numeric-consistency gate adds a precision-1.000 detector for swapped numbers, negation parity buys 7/7 flip recall at the price of zeroing every legitimate negated paraphrase, and a bag-of-words-identical reordering ("30 days hot / 13 months cold" transposed) scores a perfect 1.0 that no threshold can reach. |
| 11 | [prompt-caching](11-prompt-caching/) | Prompt-cache cost simulation — prefix matching, breakpoint strategies, TTL, and pricing multipliers replayed over seeded agent workloads (TypeScript) | Caching is a bet on repetition and the pricing makes losing it expensive: incremental breakpoints save 78.0% on a multi-conversation agent workload, but one volatile header line flips the same traffic to 1.252x of not caching at all, unique one-shot prompts pay exactly the 1.25x write premium for zero reads, a 5m-TTL cache whose turn gaps pass 5 minutes becomes a pure 1.250x loss, and a tool-heavy turn that outruns the 20-block lookback quietly rewrites the whole history every turn until one extra marker restores the win. |
| 10 | [chunking-strategies](10-chunking-strategies/) | Fixed vs sentence vs overlap chunking, measured on BM25 retrieval over an authored ops corpus (Python) | Boundary placement decides retrieval before ranking gets a vote: fixed-80 windows split 42.5% of gold answers and 17 of their 20 misses are splits rather than ranking failures, sentence packing holds splits at zero for the same index size (hit@5 0.850 vs 0.500), and overlap buys back 15 of 17 splits for +30.4% index growth while newly splitting one answer, because overlap moves every boundary instead of only adding windows. |
| 09 | [concurrency](09-concurrency/) | Batching, worker pools, and bounded parallelism over a simulated LLM batch API, on a virtual clock (TypeScript) | Every scaling knob has a sharp knee: client workers past the server's 8-call cap hold throughput at 79.3 req/s while doubling observed latency per doubling of workers (100ms to 793ms p50), batch size 8 captures 90% of the cost amortization batch 32 gets at a third of its latency, and when one unnamed bad item fails a whole 32-item call, bisection isolates it in 11 calls vs 33 one-by-one, an advantage that inverts by 4 bad items because failing halves repay the prompt overhead at every level of the tree. |
| 08 | [agent-tool-loop](08-agent-tool-loop/) | Agent loop with zod-validated tool calling and hard retry/failure policies, each malformed-arg flaw priced against a clean run (TypeScript) | Validation strictness is a budget knob: failing on the first invalid call completes 10/25 tasks, feeding zod errors back recovers 22/25 at 3x the token spend, and a loop guard that aborts on the 3rd identical invalid call keeps the recovery while cutting 80.9% of the tokens a never-correcting model burns, at the price of killing the one slow corrector plain feedback would have saved. |
| 07 | [near-duplicates](07-near-duplicates/) | MinHash + LSH banding vs SimHash for near-duplicate detection, measured against exact Jaccard ground truth (Python) | The sketch should narrow the search, not issue the verdict: well-placed banding (b=64 r=2) recovers all 360 labeled duplicate pairs at 3.5% of brute-force comparisons, one step of mistuning (s-curve at 0.383, above the 0.280 duplicate floor) silently drops 31 pairs no verification can recover, and SimHash's 64-bit fingerprint tops out at F1 0.942 because its duplicate/non-duplicate Hamming tails overlap structurally. |
| 06 | [rate-limiting](06-rate-limiting/) | Exponential backoff and jitter under a simulated thundering herd, on a deterministic virtual clock (TypeScript) | Jitter fixes synchronization, not volume: no-jitter retries collide 20-wide in lockstep while full jitter never exceeds 1, yet full jitter's peak load is *higher* because its mean delay is half; honoring Retry-After finishes closest to the ideal makespan (9.47s vs 9.0s), and client-side pacing cuts attempts-per-success from 2.99 to 1.11 by moving the waiting into your own process. |
| 05 | [token-streaming](05-token-streaming/) | Streaming LLM output in TypeScript — SSE byte parsing, partial JSON for tool arguments, backpressure, all fuzzed at chunk boundaries | The network hands you bytes, not tokens: 300/300 random chunkings parse identically once CR-on-a-boundary and split UTF-8 are handled, partial parsing puts the first tool-call field on screen at 44% of the stream instead of 100% (though an object-valued field parses as `{}` before it holds anything, so "first parsed" and "carries a value" are two different columns), and a bounded queue turns O(stream) buffering into O(1) at zero wall-time cost when the consumer is the bottleneck. |
| 04 | [bpe-tokenizer](04-bpe-tokenizer/) | Byte-level BPE from scratch — vocab size, training domain, and script, each measured against token cost | The tokenizer is a silent price multiplier: a prose-only tokenizer pays 80.7% more for the same code, CJK costs 9x English per character when training never saw it, and byte fallback holds OOV at a structural 0% while a word baseline loses 20.3% of held-out tokens to `<unk>`. |
| 03 | [hybrid-search](03-hybrid-search/) | BM25 vs dense retrieval (LSA) vs rank fusion, measured with recall@k and MRR | Dense wins paraphrase queries (MRR@10 0.793 vs 0.765), both ace exact identifiers — corpus-fit LSA can't be out-of-vocabulary — and RRF fusion takes the best overall MRR@10 (0.899) at the price of rank-blind averaging. |
| 02 | [retrieval-eval](02-retrieval-eval/) | BM25 vs TF-IDF cosine from scratch, measured with recall@k and MRR, plus paired bootstrap CIs on the gap | BM25 never loses a query to TF-IDF here — but the bootstrap shows the MRR gap (0.934 vs 0.917) rests on 2 of 38 queries and its 95% interval touches zero, while the b=0 length-norm ablation gap survives resampling. Measured beats claimed. |
| 01 | [structured-output](01-structured-output/) | Schema-validated LLM output with malformed-output retry | Free string-level repairs took success from 20% to 60%; feedback retries took it to 96.7% at a 47% call overhead — and the two layers should never be confused. |

Each project folder is self-contained: `cd` into it and its README tells
you how to run everything. Projects don't share installed dependencies;
the one exception to full isolation is that a project may import a tiny
utility from an earlier one (06 imports 05's seeded PRNG; 08 and 09
import 06's virtual clock; 11 imports 08's token estimator; 12 imports
02's TF-IDF and 10's sentence splitter) rather than keep a second copy
of the same algorithm in the same language.
