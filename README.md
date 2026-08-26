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
| 06 | [retry-backoff](06-retry-backoff/) | Exponential backoff and jitter under simulated failures — thundering herd, outage recovery with Retry-After, dead dependency | Backoff without jitter is worse than a fixed delay under a synchronized herd (p95 151s vs 18s at identical attempt counts), any jitter collapses 450-client retry collisions to 1, and obeying Retry-After verbatim re-creates the stampede at the recovery instant — the hint needs jitter too. |
| 05 | [token-streaming](05-token-streaming/) | Streaming LLM output in TypeScript — SSE byte parsing, partial JSON for tool arguments, backpressure, all fuzzed at chunk boundaries | The network hands you bytes, not tokens: 300/300 random chunkings parse identically once CR-on-a-boundary and split UTF-8 are handled, partial parsing makes tool-call fields readable at 44% of the stream instead of 100%, and a bounded queue turns O(stream) buffering into O(1) at zero wall-time cost when the consumer is the bottleneck. |
| 04 | [bpe-tokenizer](04-bpe-tokenizer/) | Byte-level BPE from scratch — vocab size, training domain, and script, each measured against token cost | The tokenizer is a silent price multiplier: a prose-only tokenizer pays 80.7% more for the same code, CJK costs 9x English per character when training never saw it, and byte fallback holds OOV at a structural 0% while a word baseline loses 20.3% of held-out tokens to `<unk>`. |
| 03 | [hybrid-search](03-hybrid-search/) | BM25 vs dense retrieval (LSA) vs rank fusion, measured with recall@k and MRR | Dense wins paraphrase queries (MRR 0.794 vs 0.769), both ace exact identifiers — corpus-fit LSA can't be out-of-vocabulary — and RRF fusion takes the best overall MRR (0.902) at the price of rank-blind averaging. |
| 02 | [retrieval-eval](02-retrieval-eval/) | BM25 vs TF-IDF cosine from scratch, measured with recall@k and MRR, plus paired bootstrap CIs on the gap | BM25 never loses a query to TF-IDF here — but the bootstrap shows the MRR gap (0.934 vs 0.917) rests on 2 of 38 queries and its 95% interval touches zero, while the b=0 length-norm ablation gap survives resampling. Measured beats claimed. |
| 01 | [structured-output](01-structured-output/) | Schema-validated LLM output with malformed-output retry | Free string-level repairs took success from 20% to 60%; feedback retries took it to 96.7% at a 47% call overhead — and the two layers should never be confused. |

Each project folder is self-contained: `cd` into it and its README tells
you how to run everything. No shared npm/pip dependencies between projects;
the one deliberate exception is source-level reuse where the repo already
has a mechanism (06 imports 05's seeded PRNG rather than rewriting it).
