# 09 concurrency: batching, worker pools, bounded parallelism, measured

Everything here is simulated: the "LLM API" is a latency and token model on a
virtual clock, prices are parameterized constants loosely shaped like current
frontier pricing, arrivals are a seeded exponential process, and the poisoned
items that fail a batch are flags the fixture set itself. The flaky items in
the extension are seeded coin flips, independent per attempt, which is the
friendliest possible flake for a retry to meet. No network, no real clock, no
API key. What the numbers demonstrate is the relative shape of the
strategies, how cost, latency and failure blast radius move against each other
under one reproducible model. Absolute values would differ against a real
provider, and the failure model (a whole batch rejected fast, no word about
which item did it) is one authored failure mode, not a survey of real ones.

## the question

Batching and parallelism are the two knobs every high-volume LLM workload
turns, and both get sold as free wins. Neither is. Client workers past the
server's concurrency cap buy nothing but inflated latency. Bigger batches buy
cheaper items and slower calls — whether that slower call reaches the item
depends on whether the items were queued behind each other anyway — and they
widen the blast radius of a single bad item. Where exactly does each knob stop
paying? Numbers or it didnt happen.

## the setup

One simulated batch endpoint: a call carrying n items takes 80ms + 20ms·n with
±10% seeded jitter, the server works at most 8 calls at once and queues the
rest FIFO. Tokens per call: 400 overhead (the shared instructions you resend
every call) + 60 input and 30 output per item, priced at $3/$15 per MTok
in/out. A call containing any poisoned item is rejected as a whole after the
base 80ms, input tokens still charged, no hint which item was at fault.

Client side, three mechanisms built here: a FIFO counting semaphore, a bounded
parallel map on top of it (fail fast or settle per item), and a micro-batcher
that holds a batch open until it hits 16 items or a wait deadline. Time is
06's virtual clock and the rng is 05's mulberry32, so every number below is a
pure function of seed 42 and reproduces exactly.

## how to run

```
npm ci
npm run typecheck
npm test
npm start
npm run start:flaky
```

## results (seed 42, printed by `npm start`)

### 1. client workers against a server that works 8 calls at once

200 single-item calls, worker count swept:

```
workers  makespan  req/s  req p50  req p95  srv queue p95  high water
      1    19.95s   10.0    100ms    109ms            0ms           1
      2     9.99s   20.0    100ms    109ms            0ms           2
      4     5.03s   39.8    100ms    109ms            0ms           4
      8     2.52s   79.3    100ms    109ms            0ms           8
     16     2.52s   79.3    199ms    211ms          107ms          16
     32     2.52s   79.3    397ms    412ms          309ms          32
     64     2.52s   79.3    793ms    812ms          708ms          64
```

Up to the cap, workers buy makespan almost linearly and latency stays flat.
Past it, throughput pins at 79.3 req/s no matter what, and every doubling of
workers doubles observed request latency instead: 100ms at 8 workers, 793ms
p50 at 64. Nothing got slower server side; the queueing just moved from your
side of the wire to theirs, where your timeout can see it. Overdriving a
capped server is how you buy timeout-triggered retries with extra steps.

### 2. items per call

240 items, 4 client workers, batch size swept:

```
batch  calls  in tok/item  $/1k items  makespan  call p50  call p95  item p50  item p95
    1    240        460.0      $1.830     6.05s     100ms     109ms    3040ms    5744ms
    2    120        260.0      $1.230     3.61s     120ms     130ms    1841ms    3470ms
    4     60        160.0      $0.930     2.40s     159ms     172ms    1256ms    2367ms
    8     30        110.0      $0.780     1.88s     239ms     258ms     984ms    1875ms
   16     15         85.0      $0.705     1.61s     402ms     431ms     838ms    1610ms
   32      8         73.3      $0.670     1.46s     724ms     771ms     771ms    1458ms
```

The cost curve is just overhead amortization, 400/n + 60 tokens per item, so
it collapses fast then flattens: batch 8 already captures 90% of the saving
batch 32 gets.

Two latency columns and they point opposite ways. `call p50` is how long one
call takes once a worker picks it up, and it climbs with n — 100ms to 724ms.
`item p50` is how long an item waits for its own answer, measured from the
start of the job, and it falls — 3040ms to 771ms. All 240 items are sitting
there at t=0, so most of what an item waits is queue time behind the other
239, and a bigger batch drains that queue sooner. Makespan says the same
thing, 6.05s to 1.46s.

So on a closed job like this, batching isnt a latency-for-cost trade at all.
It wins both. The call getting slower is real but it never reaches the item,
because the item was going to be waiting anyway.

### 3. micro-batching a live arrival stream

600 items arriving every ~20ms, batch cap 16, wait budget swept:

```
max wait  calls  mean batch  in tok/item  $/1k items  lat p50  lat p95  makespan
     0ms    600        1.00        460.0      $1.830    103ms    123ms    11.98s
    25ms    269        2.23        239.3      $1.168    150ms    198ms    12.01s
    50ms    176        3.41        177.3      $0.982    192ms    254ms    12.04s
   100ms     98        6.12        125.3      $0.826    278ms    362ms    12.09s
   250ms     46       13.04         90.7      $0.722    489ms    624ms    12.27s
```

This is where the trade actually lives. Items arrive over time instead of all
at once, so nothing is queued behind anything — the batch size is bought with
pure waiting, and the item pays it. `lat p50` here is measured from submit,
so it is the same quantity as section 2's `item p50` and it moves the other
way: holding the batch open 100ms fills it to 6 items on this arrival rate and
cuts cost 55%, for +175ms p50. Makespan barely moves at all (11.98s to 12.27s)
because the arrival stream, not the server, is the bottleneck here; the wait
budget prices latency against cost, not against throughput. Note the mean
batch at 250ms is 13, not 16: at 20ms arrivals the timer usually beats the
cap, so the cap you set is not the batch you get.

### 4. one bad item fails the whole call

Batch of 32, the API rejects the call and wont say which item; recovery
strategy swept against 1, 2 and 4 poisoned items:

```
poisoned     strategy  calls  in tokens  completed  lost  identified  elapsed
       1     fail-all      1       2320          0    31           0     82ms
       1  retry-whole      4       9280          0    31           0    329ms
       1   one-by-one     33      17040         31     0           1   3232ms
       1       bisect     11      10040         31     0           1   1494ms
       2     fail-all      1       2320          0    30           0     82ms
       2  retry-whole      4       9280          0    30           0    329ms
       2   one-by-one     33      17040         30     0           2   3210ms
       2       bisect     19      15040         30     0           2   2129ms
       4     fail-all      1       2320          0    28           0     82ms
       4  retry-whole      4       9280          0    28           0    329ms
       4   one-by-one     33      17040         28     0           4   3171ms
       4       bisect     31      21520         28     0           4   2989ms
```

retry-whole is the strategy everyone ships by accident (a generic retry wrapper
around a batch call) and it is pure waste against a deterministic rejection:
4x the tokens of fail-all, same zero items recovered. bisect finds a single
bad item in 11 calls where one-by-one needs 33. But the win erodes fast: with
4 poisoned items spread across the batch nearly every half fails, bisect makes
31 calls and actually spends more input tokens than one-by-one (21520 vs
17040), because a failing half resends all its items and repays the 400-token
overhead at every level of the tree. Bisection is a low-contamination
strategy; if you expect more than a couple bad items, just go one-by-one.

## what this teaches

Three separate queues hide in "call the API in parallel": the client pool, the
server's admission queue, and the batcher holding items open. Each one trades
the same three currencies (cost, latency, throughput) at a different rate, and
the numbers say the knees are sharp: workers stop paying exactly at the server
cap, batch size stops paying on cost around 8, wait budgets pay only while
arrivals are dense enough to fill batches.

The other thing the numbers say: pick your latency carefully. A call's
duration and an item's wait are different quantities and they can point in
opposite directions in the same experiment — at batch 1 in section 2 a call
takes 100ms while the item in it waits 3040ms. Which one is the honest
latency depends on whether the work is queued or arriving.

And batching has a fourth currency the first two knobs dont: blast radius. A
batch is a bet that all n items are good, and the recovery strategy decides
what losing that bet costs.

## the flaky poison extension: when the bad item only sometimes fails

Section 4's poison was deterministic, and this repo's own open-questions list
predicted that flake would be bisect's undoing: "if items fail
probabilistically, bisect needs repeated probes per level; at what flake rate
does it stop beating one-by-one entirely?" So this extension makes items
flaky, a per-attempt failure probability drawn from a dedicated rng (the
seeded latency stream is untouched, draws are one per flaky item per call,
never short-circuited), gives every strategy the same fairness rule, at most
4 attempts per item at singleton level, and sweeps flake rate x flaky-item
count. One trial of a coin flip is a sample, not a measurement, so every cell
is a mean over 250 seeded trials, and the trial seeds are shared across
strategies so the first call is paired exactly: every difference in the table
comes from the trials where that first call failed.

`npm run start:flaky` (seed 42, batch of 32, flaky ids spread evenly):

```
flaky  rate     strategy  1st fail  calls  in tokens  healthy done  flaky done  elapsed
    1   0.1     fail-all      8.0%    1.0     2320.0         92.0%       92.0%    666ms
    1   0.1  retry-whole      8.0%    1.1     2514.9        100.0%      100.0%    724ms
    1   0.1   one-by-one      8.0%    3.6     3499.4        100.0%      100.0%    923ms
    1   0.1       bisect      8.0%    1.2     2544.6        100.0%      100.0%    732ms
    1   0.3     fail-all     30.8%    1.0     2320.0         69.2%       69.2%    525ms
    1   0.3  retry-whole     30.8%    1.4     3303.7         99.6%       99.6%    753ms
    1   0.3   one-by-one     30.8%   11.0     6909.0        100.0%       99.6%   1521ms
    1   0.3       bisect     30.8%    1.9     3360.1        100.0%      100.0%    791ms
    1   0.5     fail-all     50.4%    1.0     2320.0         49.6%       49.6%    396ms
    1   0.5  retry-whole     50.4%    1.9     4315.2         92.8%       92.8%    741ms
    1   0.5   one-by-one     50.4%   17.6     9935.8        100.0%       95.2%   2041ms
    1   0.5       bisect     50.4%    3.0     4391.9        100.0%       99.6%    877ms
    1   0.7     fail-all     70.0%    1.0     2320.0         30.0%       30.0%    269ms
    1   0.7  retry-whole     70.0%    2.5     5911.4         74.4%       74.4%    676ms
    1   0.7   one-by-one     70.0%   24.5    13131.8        100.0%       80.0%   2595ms
    1   0.7       bisect     70.0%    5.3     6119.0        100.0%       95.6%   1058ms
    1   0.9     fail-all     90.4%    1.0     2320.0          9.6%        9.6%    141ms
    1   0.9  retry-whole     90.4%    3.4     7953.0         34.8%       34.8%    496ms
    1   0.9   one-by-one     90.4%   32.1    16627.8        100.0%       38.8%   3195ms
    1   0.9       bisect     90.4%    9.8     9022.9        100.0%       61.2%   1419ms
    4   0.1     fail-all     35.2%    1.0     2320.0         64.8%       64.8%    498ms
    4   0.1  retry-whole     35.2%    1.5     3424.3         98.8%       98.8%    755ms
    4   0.1   one-by-one     35.2%   12.4     7553.0        100.0%      100.0%   1633ms
    4   0.1       bisect     35.2%    1.9     3480.0        100.0%      100.0%    800ms
    4   0.3     fail-all     72.0%    1.0     2320.0         28.0%       28.0%    260ms
    4   0.3  retry-whole     72.0%    2.6     6106.2         71.6%       71.6%    669ms
    4   0.3   one-by-one     72.0%   25.2    13452.0        100.0%       99.5%   2656ms
    4   0.3       bisect     72.0%    5.1     6296.1        100.0%      100.0%   1054ms
    4   0.5     fail-all     92.4%    1.0     2320.0          7.6%        7.6%    129ms
    4   0.5  retry-whole     92.4%    3.6     8370.6         24.0%       24.0%    444ms
    4   0.5   one-by-one     92.4%   33.5    17286.6        100.0%       94.2%   3318ms
    4   0.5       bisect     92.4%   10.5    10067.6        100.0%       99.6%   1484ms
    4   0.7     fail-all     98.4%    1.0     2320.0          1.6%        1.6%     90ms
    4   0.7  retry-whole     98.4%    3.9     9150.1          2.8%        2.8%    333ms
    4   0.7   one-by-one     98.4%   38.6    19625.2        100.0%       76.3%   3712ms
    4   0.7       bisect     98.4%   19.3    15153.2        100.0%       92.6%   2183ms
    4   0.9     fail-all    100.0%    1.0     2320.0          0.0%        0.0%     80ms
    4   0.9  retry-whole    100.0%    4.0     9280.0          0.0%        0.0%    320ms
    4   0.9   one-by-one    100.0%   42.9    21571.9        100.0%       34.2%   4019ms
    4   0.9       bisect    100.0%   33.3    22299.4        100.0%       51.2%   3268ms
```

And the direct answer to the question, bisect's mean cost divided by
one-by-one's:

```
flaky  rate  calls ratio  tokens ratio
    1   0.1         0.33          0.73
    1   0.3         0.17          0.49
    1   0.5         0.17          0.44
    1   0.7         0.22          0.47
    1   0.9         0.31          0.54
    4   0.1         0.16          0.46
    4   0.3         0.20          0.47
    4   0.5         0.31          0.58
    4   0.7         0.50          0.77
    4   0.9         0.78          1.03
```

### the prediction was backwards

Bisect never stops beating one-by-one on calls. Not at any rate, not at any
count in this grid; the worst cell is 0.78 at 4 items flaking 90% of the
time. The one crossover in the whole table is tokens at that same extreme
cell, 1.03, and section 4 already showed the deterministic version of it
(bisect 21520 tokens vs 17040 at 4 poisoned). So the crossover the question
asked for exists, but it lives in the near-deterministic corner, exactly the
regime the question assumed flake would drag bisect away from.

The prediction failed because "bisect needs repeated probes per level" has
the mechanism inverted. Bisect only descends into a slice that failed, and
under flake a slice containing a flaky item passes whenever the item misses
its draw, which retires every item in it in one call. Flake gives bisect's
large slices a survival chance the deterministic world never allowed, so the
recursion usually collapses after a level or two. One-by-one cannot collect
that gift: once the first call fails it pays its fixed floor of 32 singleton
calls no matter how mild the flake was, which is why its calls column sits
near 33 wherever the first call usually fails.

The same mechanism decides completion. A flaky item riding a passing slice is
done, so bisect hands it extra chances beyond the shared 4-attempt singleton
budget, and at rate 0.9 with one flaky item bisect completes it 61.2% of the
time against one-by-one's 38.8%, while ALSO spending a third of the calls
(9.8 vs 32.1). Cheaper and more complete at the same time; there is no trade
here, bisect just dominates.

### retry-whole's redemption

Section 4 called retry-whole "the strategy everyone ships by accident" and
priced it as pure waste, 4x the tokens of fail-all for zero recovery. Against
flake it flips: at 1 item flaking 10%, retry-whole completes 100.0% for a
mean 1.1 calls, the cheapest full recovery in the table, and it stays above
99% up to rate 0.3. The accidental strategy is accidentally correct whenever
failures are rare and transient, which is precisely the regime generic retry
wrappers were written for. Its collapse is the all-or-nothing shape: a resend
passes only if no flaky item fires, so at 4 items flaking 0.5 it completes
24.0% while burning 3.6 calls, and at 4 x 0.9 it is section 4's dead loss
again, 4.0 calls, 0 items, every time. The healthy-done and flaky-done
columns are identical in every retry-whole row because the batch lives or
dies as one unit; healthy items are hostage to the flaky ones.

### what the extension says as one sentence

Probabilistic failure is kinder to bisection than deterministic failure,
because a passing slice retires its items whether or not they were suspects,
so the right mental model for a flaky batch is not "poison hunting got
harder" but "most attempts are now partial successes", and the strategy that
can bank a partial success at any granularity, bisect, wins the whole grid.

## typescript, and why

This is the day-job stack on purpose: the subject here IS the async runtime,
promise scheduling, semaphores handing permits to waiters, timers racing
size-triggered flushes. The micro-batcher's stale-timer problem (a virtual
timer cannot be cancelled, so a flushed batch's timer must recheck identity
before firing) is exactly the bug class real batching code has. Python would
simulate the same math but asyncio would not be the thing under test.

Imports rather than rewrites: the virtual clock and percentile come from
06-rate-limiting, the seeded rng from 05-token-streaming.

## fixes

- 2026-08-28 — the batch sweep called its latency column `item p50` but
  measured a call's duration, which leaves out the client queue the batching
  removes — so the readme read it as "past batch 8 you are trading a lot of
  latency for cents" while every item was actually getting faster. the sweep
  reports both now, `call p50/p95` (the old numbers, unchanged) and `item
  p50/p95` from job start. item p50 goes 3040ms at batch 1 down to 771ms at
  batch 32 — the opposite direction from the call column

## where it breaks down

- items are uniform: 60 in / 30 out tokens each, 20ms each. Real workloads are
  heavy-tailed, and one 4000-token item in a batch changes both the economics
  and the latency of everyone sharing its call
- the server cap is fixed and honest; real providers shed load with 429s and
  variable latency under pressure, which is 06's model, and the two arent
  composed here
- flake is independent per attempt, the friendliest model a retry can meet.
  Real flakes cluster in time (a bad shard, a deploy window, an overloaded
  dependency), and a correlated bad window would hit bisect's rapid-fire
  slice resends much harder than these numbers show
- a given-up item at rate below 1 is a false poison verdict on an item that
  could have succeeded; the table counts them (the gap under flaky done) but
  nothing here prices what quarantining a healthy-but-unlucky item costs
  downstream
- the arrival process is stationary. Bursts would make the micro-batcher's
  fixed wait budget look much worse than this steady stream does

## open questions

- adaptive batching: the right wait budget is a function of the arrival rate,
  so what does a batcher that estimates arrival density and tunes its own
  deadline recover vs the best fixed setting?
- real batch APIs sometimes name the failing index in the error; how much of
  bisect's advantage survives when a single probe call can be replaced by
  parsing the error body? under flake the named index carries one attempt's
  truth, not the item's nature, which makes the question sharper
- bisect retries only singletons here; retrying a failing slice once before
  splitting is a cheap "was that real" probe at every level, and at low rates
  it should collapse most trees to two calls, unmeasured
- correlated flake: draws here are iid per attempt, and a time-window model
  (every call inside a bad window fails) would test whether bisect's win
  survives failures that dont reroll per call
- an adaptive policy could estimate the flake rate from the failures it has
  already seen and pick a strategy per batch; what it recovers vs the best
  static column in the table is unmeasured
- composing this with 06: a server that 429s under the herd AND takes batches
  would price batching as a rate-limit dodge, since one call of 32 items costs
  one admission token
- timeout feedback: past the server cap, observed latency crosses fixed client
  timeouts, which triggers retries, which adds load; wiring 06's retry
  policies into this queueing model would show whether that loop converges or
  storms
