# 09 concurrency: batching, worker pools, bounded parallelism, measured

Everything here is simulated: the "LLM API" is a latency and token model on a
virtual clock, prices are parameterized constants loosely shaped like current
frontier pricing, arrivals are a seeded exponential process, and the poisoned
items that fail a batch are flags the fixture set itself. No network, no real
clock, no API key. What the numbers demonstrate is the relative shape of the
strategies, how cost, latency and failure blast radius move against each other
under one reproducible model. Absolute values would differ against a real
provider, and the failure model (a whole batch rejected fast, no word about
which item did it) is one authored failure mode, not a survey of real ones.

## the question

Batching and parallelism are the two knobs every high-volume LLM workload
turns, and both get sold as free wins. Neither is. Client workers past the
server's concurrency cap buy nothing but inflated latency. Bigger batches buy
cheaper items but slower ones, and they widen the blast radius of a single bad
item. Where exactly does each knob stop paying? Numbers or it didnt happen.

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
batch  calls  in tok/item  $/1k items  makespan  item p50  item p95
    1    240        460.0      $1.830     6.05s     100ms     109ms
    2    120        260.0      $1.230     3.61s     120ms     130ms
    4     60        160.0      $0.930     2.40s     159ms     172ms
    8     30        110.0      $0.780     1.88s     239ms     258ms
   16     15         85.0      $0.705     1.61s     402ms     431ms
   32      8         73.3      $0.670     1.46s     724ms     771ms
```

The cost curve is just overhead amortization, 400/n + 60 tokens per item, so
it collapses fast then flattens: batch 8 already captures 90% of the saving
batch 32 gets. The latency curve doesnt flatten, it keeps climbing with n.
So the knee is early: past batch 8 or so you are trading a lot of latency
for cents.

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

Same trade as the static sweep but the batch size is now bought with waiting:
holding the batch open 100ms fills it to 6 items on this arrival rate and cuts
cost 55%, for +175ms p50. Makespan barely moves at all (11.98s to 12.27s)
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
cap, batch size stops paying around 8, wait budgets pay only while arrivals
are dense enough to fill batches. And batching has a fourth currency the first
two knobs dont: blast radius. A batch is a bet that all n items are good, and
the recovery strategy decides what losing that bet costs.

## typescript, and why

This is the day-job stack on purpose: the subject here IS the async runtime,
promise scheduling, semaphores handing permits to waiters, timers racing
size-triggered flushes. The micro-batcher's stale-timer problem (a virtual
timer cannot be cancelled, so a flushed batch's timer must recheck identity
before firing) is exactly the bug class real batching code has. Python would
simulate the same math but asyncio would not be the thing under test.

Imports rather than rewrites: the virtual clock and percentile come from
06-rate-limiting, the seeded rng from 05-token-streaming.

## where it breaks down

- items are uniform: 60 in / 30 out tokens each, 20ms each. Real workloads are
  heavy-tailed, and one 4000-token item in a batch changes both the economics
  and the latency of everyone sharing its call
- the server cap is fixed and honest; real providers shed load with 429s and
  variable latency under pressure, which is 06's model, and the two arent
  composed here
- poison is deterministic. A flaky item (fails 30% of the time) breaks
  bisect's core assumption that a passing half is clean
- the arrival process is stationary. Bursts would make the micro-batcher's
  fixed wait budget look much worse than this steady stream does

## open questions

- adaptive batching: the right wait budget is a function of the arrival rate,
  so what does a batcher that estimates arrival density and tunes its own
  deadline recover vs the best fixed setting?
- real batch APIs sometimes name the failing index in the error; how much of
  bisect's advantage survives when a single probe call can be replaced by
  parsing the error body?
- flaky poison: if items fail probabilistically, bisect needs repeated probes
  per level; at what flake rate does it stop beating one-by-one entirely?
- composing this with 06: a server that 429s under the herd AND takes batches
  would price batching as a rate-limit dodge, since one call of 32 items costs
  one admission token
- timeout feedback: past the server cap, observed latency crosses fixed client
  timeouts, which triggers retries, which adds load; wiring 06's retry
  policies into this queueing model would show whether that loop converges or
  storms
