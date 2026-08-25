# progress

State file for the scheduled build routine. Read this first on every run.

## COMPLETED

| project | date | mechanism |
|---|---|---|
| 03-hybrid-search | 2026-08-25 | okapi bm25 from scratch + lsa dense retrieval (tf-idf → seeded truncated svd) over one shared stemmer/compound-splitting tokenizer; rrf and weighted score fusion with alpha sweep; recall@1/5 + mrr on 100 docs / 40 golden queries split keyword vs paraphrase (paraphrase mrr: bm25 0.769, dense 0.794, hybrid rrf 0.803; overall rrf best at 0.902; keyword saturated for both — corpus-fit lsa has no oov failure mode) |
| 02-retrieval-eval | 2026-08-25 | from-scratch okapi bm25 (lucene idf, k1 tf saturation, b length norm) vs sklearn-style tf-idf cosine (raw tf, smooth idf, l2 norm); evaluated with recall@1/recall@5/mrr@10 over a committed 40-doc / 38-query golden dataset, per-query head-to-head by reciprocal rank, plus a b=0 ablation isolating length normalization (mrr 0.917 tf-idf / 0.934 bm25 / 0.893 b=0); dataset includes engineered kitchen-sink distractor docs and deliberate vocabulary-mismatch queries to show where lexical retrieval fails |
| 01-structured-output | 2026-08-25 | layered JSON parse repair (fence strip, balanced-brace extraction, trailing-comma removal, python-literal fallback) + pydantic schema validation with a validation-error-feedback retry loop and hard-failure policy; benchmarked strict vs lenient vs full retry on 30 scripted-failure tickets (20.0% → 60.0% → 96.7%, 44 llm calls vs 30) |

## BLOCKED

(empty)

## NOTE FOR FUTURE RUNS

2026-08-25: two scheduled sessions ran concurrently and both picked retrieval
topics (02-retrieval-eval and 03-hybrid-search landed the same day). Before
starting work, fetch origin/main and re-read this file from there — and prefer
topics far from anything another in-flight run might pick.
