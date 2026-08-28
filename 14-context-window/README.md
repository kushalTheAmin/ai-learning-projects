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
- **buried facts pay a tax under every policy that looks at sentences.** rarity-25% holds 89.2% of standalone facts and 82.5% of buried ones, because a long chatty sentence dilutes the mean rarity of the nonce inside it. the window policies dont care, they keep or drop whole turns
- **cost is flat across policies at a fixed budget.** every 800-budget row costs about $0.074 per conversation against $0.109 for full-history, a 32% saving here. the real spread is retention at equal cost, which is the entire argument for spending eviction effort well. the saving grows with conversation length: full-history's call size nearly triples from exchange 15 to 30 while the budgeted call is flat, so on 100-exchange conversations the gap is much larger than a third

## honest caveats

- the summarize policy re-summarizes all evicted turns from scratch every call. a real incremental summarizer can never recover a sentence an earlier compression discarded, so these numbers are an upper bound for extractive summarization at each budget
- rarity salience wins partly because my fact values are nonces, maximally rare by construction. real decisions ("use postgres") contain words the conversation repeats afterward, which pulls them toward luhn territory. the honest claim is narrower: frequency salience systematically drops one-off specifics, rarity salience keeps them, and real transcripts sit between my filler and my nonces
- retention is substring presence, not answer quality. a model can miss a fact thats in context and no policy here can fix that
- the probe never restates the value. real conversations re-mention decisions, which refreshes them into any recency-based window and would flatter sliding-window relative to these numbers

## why typescript

this is the day-job shape of the problem: a chat backend deciding what to send on every request, in the stack where those backends actually get written. it also composes with the ts projects already here, 08's token estimator and pricing are imported directly rather than reimplemented, and the summarizers only needed maps and regexes, nothing from the python ecosystem

## open questions

- an incremental running summary (summarize once, carry forward, never revisit) against this recompute-from-scratch upper bound: how much retention does the irreversibility actually cost?
- assistant answers that restate facts would refresh them into a sliding window. how much of rarity-summarization's edge survives a workload where re-mention is common?
- the buried-fact tax comes from mean-based scoring. does max-token-rarity, or scoring clause spans instead of sentences, close the 89.2% vs 82.5% gap without flooding the summary with long sentences?
- retention here is binary presence. wiring these contexts into a scripted answerer (08's pattern) would price what a *missing* fact costs in wrong answers, not just percentage points
- the budgets sweep 400 to 3200 on 30-exchange conversations. the interesting production regime is the 200-exchange support thread, where even rarity-50% must eventually saturate its summary block. where does it bend?
