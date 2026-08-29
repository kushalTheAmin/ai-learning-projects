# groundedness scoring: flagging claims the context does not support

four hand-rolled scorers that take a claim and the context it supposedly came
from and say how grounded the claim is, evaluated on whether they can flag the
claims the context never said. everything here is authored for this project:
10 fake but realistic ops passages and 60 claims about them, 25 genuinely
supported and 35 hallucinated by hand in six specific ways (swapped entities,
swapped numbers, flipped negations, antonym flips, plausible fabrications,
true-but-not-in-context statements). nothing touches a model or the network.
so the headline numbers measure how these detectors behave against failure
shapes i wrote on purpose, not how often a real model hallucinates or how
often these detectors would catch it in production. what the authored classes
buy is resolution: the results say exactly which edit each scorer can and
cannot see.

## what it does

- scores every claim against its context with four methods: content-token
  overlap precision, max tf-idf cosine against any single context sentence,
  the cosine capped by a numeric consistency gate, and the gated score zeroed
  on a negation parity mismatch with the best-matching sentence
- reuses the repo instead of rewriting it: the tokenizer and tf-idf index are
  imported from `02-retrieval-eval`, the sentence splitter from
  `10-chunking-strategies`
- evaluates each method two ways that survive class imbalance: AUC (the
  probability a random unsupported claim scores below a random supported one,
  exact over all pairs) and a threshold sweep that maximizes Youden's J,
  which is recall minus false positive rate, so flag-everything scores zero
- breaks every result down by hallucination category, because "catches 43%"
  hides the real shape: which 43%

## the concept

RAG systems answer from retrieved context, and the failure that matters is an
answer the context does not support: the model swaps a number, drops a "not",
or states something true that the context never said. groundedness scoring is
the check between generation and the user. the industrial version uses an NLI
model or an LLM judge; the floor everyone reaches for first is lexical
alignment, because it is fast and free. this project measures where that floor
actually is, and it is lower than it looks: the hallucinations that matter
most are minimal edits of true sentences, and a minimal edit keeps almost all
of its surface similarity.

## how to run

```
cd 12-groundedness-scoring
pip install -r requirements.txt
python main.py
python -m pytest
```

python 3.11+, stdlib only at runtime, pytest to test. `02-retrieval-eval` and
`10-chunking-strategies` must sit next to this folder (they do, in this repo).

## the numbers

from `python main.py` over the committed dataset:

```
method              AUC  mean sup mean unsup    thr   prec  recall    FPR      J
overlap           0.521     0.685      0.675  1.000  0.640   0.914  0.720  0.194
sentence_cosine   0.432     0.668      0.762  1.000  0.647   0.943  0.720  0.223
numeric_gated     0.560     0.668      0.599  0.328  1.000   0.229  0.000  0.229
negation_aware    0.622     0.570      0.435  0.328  0.789   0.429  0.160  0.269
```

the AUC column is the story. overlap at 0.521 is a coin flip, and sentence
cosine at 0.432 is worse than a coin flip: on this dataset the average
hallucinated claim scores HIGHER than the average supported one (0.762 vs
0.668). thats not a bug, its the mechanism. the hallucinations here are edits
of real sentences, so they keep nearly all their words, while honest
paraphrases and syntheses restate the truth in new words and get punished for
it. a lexical grounding score does not rank lies below truth, it ranks
rewording below plagiarism.

the category table at each method's best threshold makes the shape explicit:

```
category                   n         overlap sentence_cosine   numeric_gated  negation_aware
verbatim           sup     7     0/7  (0.00)     0/7  (0.00)     0/7  (0.00)     0/7  (0.00)
paraphrase         sup     9     9/9  (1.00)     9/9  (1.00)     0/9  (0.00)     0/9  (0.00)
synthesis          sup     5     5/5  (1.00)     5/5  (1.00)     0/5  (0.00)     0/5  (0.00)
negated_paraphrase sup     4     4/4  (1.00)     4/4  (1.00)     0/4  (0.00)     4/4  (1.00)
fabricated         unsup   6     6/6  (1.00)     6/6  (1.00)     2/6  (0.33)     2/6  (0.33)
outside_knowledge  unsup   4     4/4  (1.00)     4/4  (1.00)     0/4  (0.00)     0/4  (0.00)
number_swap        unsup   7     7/7  (1.00)     7/7  (1.00)     6/7  (0.86)     6/7  (0.86)
entity_swap        unsup   7     7/7  (1.00)     7/7  (1.00)     0/7  (0.00)     0/7  (0.00)
negation_flip      unsup   7     6/7  (0.86)     7/7  (1.00)     0/7  (0.00)     7/7  (1.00)
antonym_flip       unsup   4     2/4  (0.50)     2/4  (0.50)     0/4  (0.00)     0/4  (0.00)
```

reading it:

- the two lexical methods have no usable threshold. their sweep lands at 1.000,
  meaning flag everything that isnt a perfect score: they catch the
  hallucinations by also flagging every paraphrase, synthesis and negated
  paraphrase in the dataset (FPR 0.720). the only claims they trust are the
  verbatim copies
- the numeric gate is the opposite temperament: precision 1.000 at FPR 0.000,
  catching only claims whose numbers the context never states. it catches 6 of
  7 number swaps; the miss is c06-5, which quotes one real number and one
  invented one, so half its numbers check out and the score (0.5) clears the
  threshold. a fraction is the wrong aggregate for evidence of fabrication,
  one bad number should be enough
- negation parity buys 7/7 on negation flips and pays exactly the price the
  code promises: all 4 supported claims that legitimately restate a positive
  sentence in negative form ("two migrations never execute at the same time")
  are zeroed too. the heuristic cannot tell a flipped fact from a mirrored one
- antonym flips beat everything. two of the four (c04-5, c09-6) reorder the
  words of a true sentence without changing the bag of words ("30 days hot and
  13 months cold" becomes "13 months hot and 30 days cold"), so every
  bag-of-words scorer hands them a perfect 1.0, indistinguishable from a
  verbatim quote. no threshold fixes a score that is identical to the truth's

## tradeoffs and where it breaks

- lexical grounding is cheap, deterministic and explainable, and this project
  shows its ceiling: AUC 0.622 with both consistency checks stacked. the gap
  to a useful detector is exactly the part that needs meaning, not surface:
  entity swaps (0/7 at the tuned threshold), bag-identical reorderings (0.50
  recall at best), and paraphrase vs fabrication (the gated methods flag only
  2 of 6 fabrications at their threshold because a fabricated sentence shares
  topic words with the context)
- the dataset is deliberately hard-mode for lexical methods: every swap and
  flip is a minimal edit. real model hallucinations include sloppier failures
  that overlap would catch. the numbers here bound the adversarial end, not
  the average case
- the negation heuristic is a 7-word cue list and a hard zero. it misses
  negation by morphology ("unavailable"), by antonym, and by contractions
  that the tokenizer splits apart
- numeric matching is exact float equality on digit literals. "45 minutes"
  written as "three quarters of an hour" passes only because the paraphrase
  has no digits to check; a unit change ("0.75 hours") would false-flag
- thresholds are tuned and evaluated on the same 60 claims, the same
  reading-tea-leaves caveat 03 carries for its alpha sweep. with 60 claims
  the operating points are illustrations, not settings to ship

python was the right language here: the pieces this project stands on (02's
tf-idf and tokenizer, 10's sentence splitter) are python, and importing them
keeps one implementation of each mechanism per language instead of a second
opinion in typescript.

## fixes

- 2026-08-29 — the number extractor read digits out of the middle of a token,
  so "p99" handed the numeric gate a 99 that isnt a quantity anyone asserted —
  and since the context says "p99" too, that phantom number always checked out.
  c06-5 swaps 210 ms for 610 ms and scored 2 of 3 numbers matched instead of
  the 1 of 2 it actually has. a numeric literal has to start at a token
  boundary now. c06-5 0.667 → 0.500, numeric_gated AUC 0.553 → 0.560,
  negation_aware 0.615 → 0.622, and the mean unsupported columns move with
  them. no category row and no operating point changed

## open questions

- an embedding model would score the paraphrases this project punishes, and
  the fashionable NLI/judge stack claims the whole table. same missing piece
  as 03's pretrained-embedder thread: run the same 60 claims through a real
  encoder and see which categories actually move
- the numeric gate should be an AND, not a fraction: one unverifiable number
  is evidence, half-credit is not. but claims citing many numbers where one
  is legitimately rounded ("about 45 minutes" vs 43) would then false-flag;
  the tolerance policy is the real design problem
- claim extraction is assumed here: the dataset hands over clean single-fact
  claims. real answers are multi-sentence and a groundedness score per answer
  needs splitting first; 10's sentence splitter is the obvious start, and
  what splitting errors do to the score is unmeasured
- entity swaps are the biggest unguarded class. a cheap entity gate (match
  capitalized tokens and known product names the way numbers are matched)
  might do for names what the numeric gate does for figures, and its false
  positive cost on paraphrases that drop titles is unknown
