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

New projects get added by a scheduled Claude Code routine that runs while
I'm away, then I review, run, and pick apart what it built — reading code
you didn't watch being written is its own skill, and it's basically the
applied-AI job description now.

## Projects

| # | Project | Concept | One-line takeaway |
|---|---------|---------|-------------------|
| 03 | [hybrid-search](03-hybrid-search/) | BM25 vs dense retrieval (LSA) vs rank fusion, measured with recall@k and MRR | Dense wins paraphrase queries (MRR 0.794 vs 0.769), both ace exact identifiers — corpus-fit LSA can't be out-of-vocabulary — and RRF fusion takes the best overall MRR (0.902) at the price of rank-blind averaging. |
| 02 | [retrieval-eval](02-retrieval-eval/) | BM25 vs TF-IDF cosine from scratch, measured with recall@k and MRR | BM25's term saturation and length normalization beat TF-IDF (MRR 0.934 vs 0.917), the b=0 ablation proves length norm does the work — and the two paraphrase queries both systems miss are the entire case for dense retrieval. |
| 01 | [structured-output](01-structured-output/) | Schema-validated LLM output with malformed-output retry | Free string-level repairs took success from 20% to 60%; feedback retries took it to 96.7% at a 47% call overhead — and the two layers should never be confused. |

New projects are added to this table by the routine as they're built. Each
project folder is self-contained: `cd` into it and its README tells you how
to run everything. No shared dependencies between projects.
