# context window management: what to keep when the conversation outgrows the budget

everything here is simulated. the conversations are generated from a seeded phrase bank, the "facts" are planted nonce values like `vega-atlas-7`, and there is no model anywhere, a probe counts as answered when the fact value is literally present in the assembled request context. so the numbers measure what each eviction policy keeps and what it costs, not whether a model would actually use what was kept. a fact being in context is necessary for a grounded answer, it isnt sufficient. the retention rates are properties of my authored workload; the shapes of the curves are the transferable part, not the exact percentages.

## the problem

every turn of a chat costs the whole history as input tokens. let it grow and per-call cost grows linearly, whole-conversation cost quadratically, and eventually the window is full. so production systems evict. the question is what to evict, and the failure mode is a user asking about a decision from 40 turns ago that the policy silently threw away.

four policies, all pure functions of (history, budget):

- **full-history**: keep everything, the baseline that gets expensive
- **sliding-window**: keep the newest whole turns that fit, a contiguous suffix
- **head-and-tail**: pin the first 4 turns, then fill the rest with the newest, drop the middle
- **summarize-evicted**: reserve a share of the budget for an extractive summary of the evicted turns, sliding window with the rest

the summarize policy comes in two flavors that differ only in how they rank evicted sentences:

- **luhn** (1958): a sentence matters if it has a dense cluster of words that are FREQUENT in the text. built for articles, where the topic repeats
- **rarity**: a sentence matters if its content words are RARE across sentences, scored by mean inverse sentence frequency. a decision stated once is made of rare tokens

## the workload

20 seeded conversations, 30 user/assistant exchanges each, ops-flavored filler chatter. 12 facts per conversation are planted in assistant turns (key + unique nonce value), half as short standalone sentences ("decision: the deploy target is mira-vega-3."), half buried inside long chatty sentences. each fact is probed by a later user turn at a controlled lag: short (1-2 exchanges), medium (3-8), long (9-20). the value occurs exactly once in the whole conversation and the probe never restates it, so retention is purely a property of the policy. token counts use 08's ~4 chars/token estimator, prices are 08's $3/MTok input, $15/MTok output.

## run it

```
npm ci
npm run typecheck
npm test
npm start
```

node 20+. no network, no api key, everything is deterministic from seeds.

## what came out

```
policy            budget   overall    short   medium     long   standalone   buried  in-tok/call     $/conv
full-history           0    100.0%   100.0%   100.0%   100.0%       100.0%   100.0%     1037.5    $0.1091
sliding-window       400     48.3%   100.0%    45.0%     0.0%        49.2%    47.5%      352.5    $0.0474
head-and-tail-4      400     45.8%   100.0%    20.0%    17.5%        45.8%    45.8%      353.1    $0.0475
summ-luhn-25%        400     42.1%   100.0%    26.3%     0.0%        43.3%    40.8%      349.6    $0.0472
summ-rarity-25%      400     60.0%   100.0%    53.8%    26.3%        65.8%    54.2%      347.3    $0.0470
sliding-window       800     74.6%   100.0%   100.0%    23.8%        78.3%    70.8%      650.6    $0.0743
head-and-tail-4      800     75.0%   100.0%   100.0%    25.0%        74.2%    75.8%      651.8    $0.0744
summ-luhn-25%        800     71.3%   100.0%    98.8%    15.0%        69.2%    73.3%      647.3    $0.0740
summ-rarity-25%      800     85.8%   100.0%   100.0%    57.5%        89.2%    82.5%      646.6    $0.0739
sliding-window      1600    100.0%   100.0%   100.0%   100.0%       100.0%   100.0%     1001.8    $0.1059
```

(the 1600 rows for the other policies and the full 3200 block are all at or near 100%, `npm start` prints everything.)

the growth story, mean input tokens of the call at exchange 1 / 15 / 30:

```
full-history         66.9   1039.4   1876.7
sliding-window       66.9    776.8    777.5
```

and the summary share sweep at budget 800, which is the finding i care about:

```
luhn-10%             800     72.1%   100.0%   100.0%    16.3%        73.3%    70.8%      646.7    $0.0739
luhn-25%             800     71.3%   100.0%    98.8%    15.0%        69.2%    73.3%      647.3    $0.0740
luhn-50%             800     61.7%   100.0%    67.5%    17.5%        57.5%    65.8%      648.9    $0.0741
rarity-10%           800     81.3%   100.0%   100.0%    43.8%        85.8%    76.7%      648.6    $0.0741
rarity-25%           800     85.8%   100.0%   100.0%    57.5%        89.2%    82.5%      646.6    $0.0739
rarity-50%           800     97.1%   100.0%    98.8%    92.5%       100.0%    94.2%      647.1    $0.0739
```

## what the numbers mean

- **a budget is a cliff for sliding windows.** at 800 tokens the window holds about 11 exchanges, so short and medium lag probes are perfect and long lag drops to 23.8%. the policy has no memory past its own edge, retention by lag is a step function
- **head-and-tail buys early facts with medium ones.** at 400 it holds 17.5% of long-lag probes where sliding holds 0.0%, because facts introduced in the pinned head stay forever. the price shows at the same budget: medium drops from 45.0% to 20.0%, the pinned head is budget the tail doesnt get
- **summarizing with the wrong salience is worse than not summarizing.** luhn-25% at 800 lands at 71.3% overall against sliding-window's 74.6%, and its long-lag column reads 15.0% against 23.8%. the summary block spent budget on chatter, and the tail it displaced was holding real facts. more summary makes it worse: luhn at 50% share falls to 61.7%
- **the failure is the salience definition, not summarization.** luhn keeps what the conversation talks about most, but a decision stated once is by definition the rarest thing in the transcript. flip the scorer to rarity and the same policy at the same budget goes to 85.8% overall and 57.5% long-lag, at the same cost. the share sweep slopes in opposite directions for the two scorers: more luhn summary loses facts, more rarity summary keeps them (92.5% long-lag at 50% share)
- **the standalone vs buried split doesnt hold up, and it isnt a sentence-scoring effect.** rarity-25% at 800 keeps 89.2% of standalone facts against 82.5% of buried ones, which reads like a tax on burying a nonce inside a long chatty sentence — until you check the neighbouring rows. luhn-25% at the same budget goes the other way (69.2% standalone, 73.3% buried), and sliding-window, which never looks at a sentence at all, has the widest split in the table (78.3% vs 70.8%). thats 120 probes a side and no gap anywhere in the sweep clears two standard errors — the biggest is rarity-25% at 400, 11.7 points at z=1.84. there is a mechanism that would explain a *window* gap if the effect were real — a buried intro turn is 73.9 tokens against a standalone one's 34.3, so it drops out of a token budget sooner — but this workload cant separate any of it from noise
- **cost is flat across policies at a fixed budget.** every 800-budget row costs about $0.074 per conversation against $0.109 for full-history, a 32% saving here. the real spread is retention at equal cost, which is the entire argument for spending eviction effort well. the saving grows with conversation length: full-history's call size nearly doubles from exchange 15 to 30 (1039.4 to 1876.7, 1.81x) while the budgeted call is flat, so on 100-exchange conversations the gap is much larger than a third

## honest caveats

- the summarize policy re-summarizes all evicted turns from scratch every call. a real incremental summarizer can never recover a sentence an earlier compression discarded, so these numbers are an upper bound for extractive summarization at each budget
- rarity salience wins partly because my fact values are nonces, maximally rare by construction. real decisions ("use postgres") contain words the conversation repeats afterward, which pulls them toward luhn territory. the honest claim is narrower: frequency salience systematically drops one-off specifics, rarity salience keeps them, and real transcripts sit between my filler and my nonces
- retention is substring presence, not answer quality. a model can miss a fact thats in context and no policy here can fix that
- the probe never restates the value. real conversations re-mention decisions, which refreshes them into any recency-based window and would flatter sliding-window relative to these numbers

## fixes

- 2026-08-30 — the buried-fact retraction above only reached the readmes —
  progress.md still carried the retracted mechanism in two live places, the
  completed row calling it "a mean-dilution tax under sentence scoring" and the
  open thread asking which scorer would close it. both restated the way this
  readme reads now, and two tests pin the ledger to the run the same way they
  already pin the readme

- 2026-08-30 — the cost bullet said full-history's call "nearly triples from
  exchange 15 to 30", but the two numbers printed three lines above it are
  1039.4 and 1876.7 — 1.81x, it nearly doubles. now says doubles and quotes the
  pair and the multiple, in both this readme and the root index row. the
  argument is unchanged, only the magnitude word

- 2026-08-30 — the buried-fact bullet claimed sentence-scoring policies tax
  buried facts and window policies dont, but the same table refutes both halves:
  luhn-25% at 800 holds buried better than standalone (73.3% vs 69.2%) and
  sliding-window has the widest split of any row (78.3% vs 70.8%). rewritten
  around what the sweep shows — no gap in it clears two standard errors at 120
  probes a side — and pinned by a test. no measured number moved

## extension: the incremental summary, and what irreversibility costs

the summarize policy above is stateless: every call it re-reads every evicted turn and packs a fresh summary. that makes it an upper bound in two directions at once. it pays a re-read bill that grows with the whole conversation, and it can resurrect a sentence an earlier packing dropped, because next call the full evicted text is back on the table. no production summarizer works like that. the production shape folds turns into a running summary once, and each compaction sees only the previous summary plus the newly evicted turns. a sentence the packer drops is gone for good.

`src/incremental.ts` is that shape, built on the same fillTail, packing, and rendering arithmetic as the stateless policy, so on its very first compaction the two produce byte-identical contexts (pinned by a test). after that they diverge, and the divergence is the measurement. two regimes: the original 30-exchange conversations, and a 60-exchange long regime where far more text passes through the summary. same 240 probes each.

```
npm run start:irreversible
```

what came out, share 25%, both regimes (work/conv is tokens handed to the sentence ranker per conversation, the stand-in for what an llm summarizer would have to re-read; drop/conv is sentences discarded per conversation; sum-tok is the running summary size after the last call):

```
=== standard regime (30 exchanges): recompute vs incremental at summary share 25% ===
policy              budget   overall    short   medium     long   work/conv   cmp/conv   drop/conv   sum-tok
recompute-luhn-25%     400     42.1%   100.0%    26.3%     0.0%       21297       25.0           -         -
increm-luhn-25%        400     42.1%   100.0%    26.3%     0.0%        3038       23.4        68.5      71.1
recompute-luhn-25%     800     71.3%   100.0%    98.8%    15.0%       14231       19.1           -         -
increm-luhn-25%        800     69.6%   100.0%    98.8%    10.0%        4017       17.6        48.6     171.0
recompute-luhn-25%    1600     99.6%   100.0%   100.0%    98.8%        3121        5.8           -         -
increm-luhn-25%       1600     99.6%   100.0%   100.0%    98.8%        2195        5.2        13.1     370.4
recompute-rarity-25%     400     60.0%   100.0%    53.8%    26.3%       21297       25.0           -         -
increm-rarity-25%      400     53.3%   100.0%    53.8%     6.3%        3031       23.3        67.8      72.1
recompute-rarity-25%     800     85.8%   100.0%   100.0%    57.5%       14231       19.1           -         -
increm-rarity-25%      800     82.1%   100.0%   100.0%    46.3%        3992       17.5        49.9     167.8
recompute-rarity-25%    1600    100.0%   100.0%   100.0%   100.0%        3121        5.8           -         -
increm-rarity-25%     1600    100.0%   100.0%   100.0%   100.0%        2186        5.2        13.3     368.2

=== long regime (60 exchanges): recompute vs incremental at summary share 25% ===
policy              budget   overall    short   medium     long   work/conv   cmp/conv   drop/conv   sum-tok
recompute-luhn-25%     400     40.8%   100.0%    22.5%     0.0%       91255       54.3           -         -
increm-luhn-25%        400     40.8%   100.0%    22.5%     0.0%        6754       52.9       157.9      66.8
recompute-luhn-25%     800     70.8%   100.0%    98.8%    13.8%       76056       48.2           -         -
increm-luhn-25%        800     70.8%   100.0%    98.8%    13.8%       10667       46.8       137.9     170.4
recompute-luhn-25%    1600     97.5%   100.0%   100.0%    92.5%       48979       35.2           -         -
increm-luhn-25%       1600     96.7%   100.0%   100.0%    90.0%       14600       34.2        98.8     369.8
recompute-rarity-25%     400     66.3%   100.0%    58.8%    40.0%       91255       54.3           -         -
increm-rarity-25%      400     51.7%   100.0%    51.2%     3.8%        6767       52.9       157.6      67.8
recompute-rarity-25%     800     92.9%   100.0%   100.0%    78.8%       76056       48.2           -         -
increm-rarity-25%      800     87.5%   100.0%    98.8%    63.7%       10614       46.9       139.2     167.4
recompute-rarity-25%    1600    100.0%   100.0%   100.0%   100.0%       48979       35.2           -         -
increm-rarity-25%     1600     99.6%   100.0%   100.0%    98.8%       14563       34.2       100.8     368.9
```

reading it:

- **irreversibility is priced in long-lag retention, and only where the summary was earning anything.** rarity at budget 400 in the long regime loses 14.6 points overall (66.3% recompute vs 51.7% incremental), and the whole loss is the long-lag column collapsing from 40.0% to 3.8%. same cell under luhn: gap 0.0 points, because luhn's summary was keeping repeated chatter rather than facts, so there was nothing to lose. a policy has to be good before irreversibility can hurt it
- **the gap grows with pressure and shrinks with slack.** rarity gaps run 6.7 / 3.7 / 0.0 points across budgets 400 / 800 / 1600 in the standard regime, and 14.6 / 5.4 / 0.4 in the long one. at 1600 nearly everything survives in the raw tail anyway, so the summary is decoration and both shapes agree
- **what recompute pays for those points is the actual story.** at budget 400 in the long regime it re-reads 13.5x the tokens (91255 vs 6767 per conversation), at 800 it is 7.2x, at 1600 3.4x. and recompute's bill grows with conversation length while incremental's per-call bill is bounded by summary size plus newly evicted text: the standard regime costs recompute 21297 work tokens per conversation, the long regime 91255, 4.3x for 2x the exchanges. that superlinear growth is exactly why nobody ships the recompute shape, and now the retention it buys has a number attached
- **a transiently long user turn permanently shrinks the summary.** when a call arrives with less room and nothing new to fold, the running summary must repack itself down to the smaller block, and the sentences it sheds do not come back when the next call has normal room again (2 to 3 such shrink repacks per 20-conversation cell here, pinned by a test). the stateless policy just repacks bigger next call and never notices

the share sweep at budget 800 in the long regime sharpens the first point. under rarity the recompute advantage grows with the share, because a bigger summary block is a bigger fraction of retention riding on the summarizer: recompute-rarity-50% holds 98.8% overall while increm-rarity-50% holds 89.6%, a 9.2-point gap at the same budget. and in the one corner where the summary holds nearly nothing (luhn at share 10%), incremental actually wins by half a point, 76.3% vs 75.8%: a fact sentence that survives an early packing is locked in for good, while recompute re-ranks the whole pool every call and can drop it later. irreversibility cuts both ways, it just cuts against you far more often

sum-tok says the discards are real: at share 25% the running summary ends within a few tokens of its block budget (167 to 171 at budget 800, against a block of roughly 180), so the packer is dropping sentences because it must, not because they scored zero

## why typescript

this is the day-job shape of the problem: a chat backend deciding what to send on every request, in the stack where those backends actually get written. it also composes with the ts projects already here, 08's token estimator and pricing are imported directly rather than reimplemented, and the summarizers only needed maps and regexes, nothing from the python ecosystem

## open questions

- assistant answers that restate facts would refresh them into a sliding window. how much of rarity-summarization's edge survives a workload where re-mention is common?
- every standalone vs buried gap here sits inside noise at 120 probes a side. does the effect exist at all — more conversations, or the same fact planted at a controlled sentence length — and if it does, is it mean-based scoring diluting the nonce or just the extra tokens a buried turn costs a window?
- retention here is binary presence. wiring these contexts into a scripted answerer (08's pattern) would price what a *missing* fact costs in wrong answers, not just percentage points
- the extension took the regime from 30 to 60 exchanges and the irreversibility gap widened (3.7 to 5.4 points for rarity-25% at 800). the 200-exchange support thread is still unrun, and the gap there is not obviously a straight extrapolation: the summary block saturates and every compaction past that point is zero-sum
- summary sentences carry no age. once the block saturates, each compaction competes newly folded sentences against ancient ones on salience alone, so a conversation's early facts can squat in the block forever. an age-decayed score, or a reserved share for recent folds, changes what irreversibility deletes, and neither is measured
- the shrink repack means one long user turn permanently costs summary sentences. packing to a floor below the block budget, or deferring the repack one call, would absorb transients; what either buys back is unmeasured
- increm-luhn-10% beating its own recompute row by half a point says lock-in can protect a fact from later re-ranking. one cell is an anecdote; whether small-share incremental summaries systematically benefit from lock-in is a sweep away
- both summarizers here select sentences verbatim. a real llm summarizer rewrites, so its irreversibility compounds through paraphrase drift (the summary of a summary of a summary), which extractive selection structurally cannot show. that measurement needs a model
