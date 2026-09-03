# 04 — bpe tokenizer from scratch, and what it means for cost

everything here runs offline — no model, no api, no third-party deps beyond
pytest. the corpus is authored for this project: ~14KB of technical prose,
~7KB of python, and a multilingual sheet for the unicode measurements. that
matters for reading the numbers — the *shapes* below (diminishing returns on
vocab size, the domain penalty, the script penalty) are the real phenomena,
but the exact percentages describe this small corpus, not the web-scale
corpora production tokenizers train on. the dollar figures use an assumed
$3.00 per million tokens, which is an example rate and not any provider's
real price — the ratios are the measurement, the rate is an input.

## what it is

byte-level byte-pair encoding in plain python — training, encoding, decoding,
save/load — plus word-level and char-level baselines, and a benchmark that
measures what actually moves token counts: vocabulary size, training domain,
and script.

ive been passing text to tokenizers through libraries for a while without
being able to say precisely why "the" is one token and "缓存" is six. now i
can.

## the concept

start with 256 tokens — the raw byte values. count every adjacent pair of
tokens in the corpus, merge the most frequent pair into a new token, repeat
until you hit the vocab budget or no pair occurs twice. thats the whole
training algorithm. encoding replays those merges on new text in the order
they were learned — never greedy longest-match, which gives different and
worse answers.

starting from bytes instead of characters buys the property that makes this
the industry default: nothing is ever out of vocabulary. worst case, an
unseen character falls back to its raw bytes. the baselines show what youre
buying — my word-level tokenizer hits 20.3% unknown tokens on held-out prose
and each one decodes to `<unk>`, information gone. even the char-level
tokenizer meets 277 characters it has no id for. bpe round-trips every file
exactly, including scripts it never trained on.

that word-level number isnt a handicap i imposed. it got the mixed bpes 1659
slots and could only fill 1402 — the training text has 1401 word types and
thats all there is to buy, so 257 slots go unspent. hand it ten times the
budget and it builds the same vocabulary. 20.3% is the ceiling for a closed
word vocab on this corpus, not a small one being unfair.

and the reason this lives in an ai repo: apis price per token, so the
tokenizer is a silent multiplier on every bill. same text, different
tokenizer fit — different invoice.

## run it

```
cd 04-bpe-tokenizer
pip install -r requirements.txt
python -m pytest tests/ -q
python run_benchmark.py
```

## the numbers

vocab size sweep, trained on prose, measured on held-out prose:

```
 vocab  tokens  bytes/token  vs raw bytes
   256    3106         1.00          0.0%
   512    1406         2.21         54.7%
  1024    1106         2.81         64.4%
  1246    1058         2.94         65.9%
```

the first 256 merges cut token count in half. the next 734 buy eleven more
points. classic diminishing returns — and training stopped itself at 990
merges because no pair occurred twice anymore. a 20KB corpus simply cannot
justify a 2048 vocab, which is itself a lesson the run prints rather than
hides.

domain transfer — the same held-out files through a tokenizer trained on
prose only vs prose+code (bytes per token, higher = cheaper):

```
 heldout   prose@1246   mixed@1659   mixed@1246
   prose         2.94         2.98         2.80
    code         1.49         2.70         2.56
 unicode         1.23         1.24         1.23
```
```
at a matched 1246 vocab, adding code to training cuts code tokens 41.8% and costs prose 4.9% — one budget, two domains, already crowding
```

the prose-only tokenizer nearly halves its efficiency on code — it has never
seen `self.` or `return` often enough to merge them. the third column is the
honest control: the mixed tokenizer truncated to the same 1246 vocab still
hits 2.56 on code, so the win is the training domain, not the extra vocab
slots.

that control cuts both ways and its worth saying out loud — read the middle
column and mixed training looks free, 2.98 on prose against 2.94. it isnt.
that column has 413 extra vocab slots paying for both domains at once. hold
the budget fixed and prose goes 2.94 → 2.80, 4.9% more tokens, because every
slot a `self.` merge takes is a slot some prose merge doesnt get. two domains
is already enough to see it. in cost terms, from the run:

```
1 MB of code through prose-trained bpe: ~669,811 tokens = $2.01
1 MB of code through mixed-trained bpe: ~370,620 tokens = $1.11
the prose-only tokenizer pays 80.7% more for the same code — training on code too cuts the bill 44.7%
```

script cost, tokens per character through the mixed tokenizer:

```
     english prose        0.335
           spanish        0.486  ( 1.4x english)
            german        0.651  ( 1.9x english)
           russian        1.835  ( 5.5x english)
          japanese        3.000  ( 9.0x english)
           chinese        3.000  ( 9.0x english)
            korean        2.492  ( 7.4x english)
```

chinese and japanese land on exactly 3.000 — every cjk character is three
utf-8 bytes and the tokenizer learned zero merges for them, so each character
costs three whole tokens. nine times the per-character price of english,
purely because of what the tokenizer saw during training. this is the
much-discussed tokenizer inequity, reproduced on a 20KB corpus with 150 lines
of stdlib python. one caveat the table hides: the emoji row reads 0.699 but
that line is emoji scattered through english words, not a pure emoji stream —
per-line granularity flattens whats inside the line.

## details worth knowing

- merges apply by learned rank, not longest-first. `tests/test_bpe.py` pins
  this with a hand-built merge table where the two strategies disagree.
- training is fully deterministic: frequency ties break to the
  lexicographically smallest pair. that buys the prefix property — a
  tokenizer trained to vocab 264 is literally the first 8 merges of one
  trained to 280 — so the sweep trains once and truncates, and theres a test
  holding that truncating equals retraining.
- pretokenization is the regex `" ?\S+|\s+"` — merges never cross word
  boundaries, and a words leading space merges with it, so ` the` becomes a
  single token. production tokenizers use much fancier patterns (splitting
  contractions, capping digit runs); mine is the honest minimum.
- decode of a token stream cut mid-character yields U+FFFD instead of
  raising — the streaming reality, tested.

## where it breaks down

- the naive trainer recounts every pair each merge — fine at 20KB and 3
  seconds, hopeless at gigabytes. real trainers keep incremental pair counts
  and touch only the sequences a merge changed.
- scripts that dont use spaces get no help from my word-boundary rule — a
  whole chinese sentence arrives as one pretoken piece, so with enough cjk
  training data merges would happily span what a reader considers words.
- merge exhaustion: on a corpus this small the vocab budget is aspirational.
  both trainings stopped early and the run says so out loud.

## fixes

- 2026-09-03 — the baselines section printed "matched vocab 1659" and the
  readme called the word tokenizer vocab-matched to the bpe. it isnt — it
  builds 1402, because the training text only has 1401 word types. the run
  now prints the vocab it actually built and says 257 slots went unspent. no
  measured number moves, the budget was never binding
- 2026-08-27 — the open questions said mixed training won on code "without
  hurting prose", read off the mixed@1659 column the readme itself calls
  confounded. the honest control says the opposite. the run now prints the
  matched-vocab trade in both directions and the readme quotes it — prose
  costs 4.9% to buy 41.8% on code

## open questions

- how far are these learned merges from a production tokenizers on identical
  text? needs a real pretrained vocab on this corpus — fertility head to
  head, my 990 merges vs their 100k
- compression isnt quality. a bigger vocab is cheaper per request, but
  whether it helps or hurts a downstream model is invisible without a model
- at what corpus size does the naive recount trainer actually fall over, and
  what does the incremental-update trainer cost to build? same shape as 02s
  inverted-index question
- crowding is already measurable at two domains — 4.9% on prose to buy 41.8%
  on code. what does the curve look like as domains pile up, and is there a
  budget past which adding a domain stops paying for itself at all?
- per-script accounting finer than per-line — the emoji row is diluted by the
  english around it, and a codepoint-class breakdown would say what each
  script actually costs
