# 06 rate limiting: exponential backoff and jitter, measured

Everything here is simulated: the API server is a token bucket with seeded
latency and seeded transient faults, the clients are scripted, and time itself
is virtual, so no network, no real clock, no API key. The numbers below measure
how retry strategies behave against *this* congestion model (a one-shot
thundering herd against a fixed refill rate), not against any real provider.
What they demonstrate is the relative shape of the strategies, synchronization,
wasted work, tail latency, under identical, reproducible contention; absolute
values would differ against real traffic, which bursts and drains far less
cleanly than a t=0 herd.

## the question

Everyone ships `min(cap, base * 2^attempt)` and calls it a day. The AWS
Architecture Blog's claim is that the jitter, not the exponent, is what saves
you when many clients fail together. Is that visible in numbers, and what
exactly does jitter buy, given that full jitter *shortens* the average delay?

## the setup

40 clients each fire 5 sequential requests starting at t=0 against a server
budgeted at 20 req/s with a burst of 20 (so 200 requests against a 9.0s ideal
makespan). Admitted requests take 20 to 60ms and fail transiently 2% of the
time. Retry budget: base 100ms, cap 10s, max 8 retries. Same seed, fresh server
per strategy. Rejections are instant 429s carrying a Retry-After hint; whether
a strategy listens to it is part of the strategy.

All waiting goes through a virtual clock (timers fire in deterministic
(time, schedule-order) order), so a strategy's entire run is a pure function
of the seed. Rerun it and every number below reproduces exactly.

## results (seed 42, printed by `npm start`)

| strategy | success | attempts | att/ok | 429s | makespan | p50 ok | p99 ok | p50 all | peak/100ms | collide |
|---|---|---|---|---|---|---|---|---|---|---|
| no-retry | 10.5% | 200 | 9.52 | 179 | 0.07s | 40ms | 56ms | 0ms | 200 | 0 |
| fixed-100ms | 43.5% | 1333 | 15.32 | 1245 | 3.50s | 229ms | 849ms | 800ms | 69 | 20 |
| exp-no-jitter | 100.0% | 593 | 2.96 | 393 | 12.90s | 152ms | 6353ms | 152ms | 61 | 20 |
| exp-full-jitter | 99.0% | 592 | 2.99 | 392 | 14.66s | 56ms | 10636ms | 56ms | 104 | 1 |
| exp-equal-jitter | 100.0% | 569 | 2.85 | 366 | 11.35s | 108ms | 10601ms | 108ms | 86 | 1 |
| decorrelated | 96.5% | 615 | 3.19 | 420 | 10.92s | 240ms | 7715ms | 277ms | 61 | 1 |
| full-jitter+retry-after | 99.5% | 591 | 2.97 | 390 | 9.47s | 56ms | 8908ms | 57ms | 92 | 12 |
| full-jitter+pacing | 100.0% | 223 | 1.11 | 20 | 16.63s | 40ms | 5611ms | 40ms | 21 | 1 |

`att/ok` = server-side attempts per successful request. `collide` = the most
retries arriving at the exact same virtual instant. `p50 ok` and `p99 ok` cover
requests that succeeded; `p50 all` covers every request, give-ups included. The
two agree wherever a strategy lands nearly everything, and part company exactly
where it doesnt, so read the `ok` columns down the table only between rows whose
success rates match.

## what the numbers say

**Synchronization, not volume, is what jitter fixes.** Jitterless exponential
backoff retries in lockstep: the 20 clients rejected at t=0 all come back at
exactly t=100ms, then exactly t=300ms, 20-wide collisions against a bucket
that refills 2 tokens per 100ms. Full jitter never collides more than 1-wide.
But its *peak-window load is higher* (104 vs 61 arrivals/100ms): full jitter
draws from [0, exp), so its mean delay is half the exponential and it retries
sooner. The p50 shows the same trade from the client's side, 56ms vs 152ms
(both strategies land nearly every request, so those two medians compare).
Jitter doesnt spread load thinner here; it stops the herd from arriving as a
wall.

**Retrying without backing off is the worst of both worlds.** Fixed 100ms
delay burns 15.32 attempts per success, over 5x the work of any exponential
variant, and still fails 56.5% of requests, because 9 attempts spaced 100ms
apart only ever sample ~0.8s of a congestion window that takes ~9s to drain.
The exponential variants all succeed on ~3 attempts per request by reaching
multi-second delays that actually outlive the congestion.

**A latency measured only over successes flatters whatever gives up most.**
Read the `p50 ok` column alone and no-retry is the fastest strategy here at
40ms, ahead of every variant that actually works. It isnt fast, it quits: 89.5%
of its requests were rejected at t=0 and never appear in that number, so its
median request took 0ms. Fixed-100ms reads 229ms `ok` against 800ms over every
request, because a give-up spends the whole 8-retry budget first and then
counts for nothing. This is the trap in every dashboard that charts p50 over
2xx only, and it is why the table carries both populations.

**The server knows best.** Honoring Retry-After (the time until the bucket's
next token) finishes in 9.47s, closest to the 9.0s ideal, while every
guessing strategy takes 10.92 to 14.66s. The hint is deterministic, so it partially
re-synchronizes clients (collide 12), which is why real APIs jitter their
hints or tolerate the residual herd. The outage extension below measures
the jittered hint, and also finds this row's 9.47s is the luckiest of 5
seeds; the ordering holds, the quoted margin was seed luck.

**Client-side pacing beats retrying at all.** A shared token bucket that
*waits* before sending, matched to the server's budget, turns 392 rejections
into 20 and 2.99 att/ok into 1.11. But pacing at exactly the server rate
leaves zero headroom, so local queueing stretches the makespan to 16.63s. The
20 leftover 429s are all downstream of the 3 transient 503s: those retries
re-enter without a pacing token, and each stolen server token can bounce a
paced first attempt (0 here; a pinned test shows 1 of 27 on another seed).
Pacing changes *where* requests wait, in your process, not in the retry loop,
and pushes the 429 problem into whatever traffic bypasses the pacer.

**Jitter's cost is a fatter success tail (part two below).** No-jitter finishes 100% with p99
6353ms; full jitter fails 2 requests and decorrelated 7, with p99 over 10s: a
short-drawn jitter delay burns a retry cheaply, so an unlucky request can
exhaust all 8 retries before congestion clears. Equal jitter, which floors
every delay at half the exponential, keeps 100% success with fewer attempts
than either. Under a bounded retry budget, the floor matters.

## the outage extension: jittered hints, hard downs, dead services

the first run left two questions open: does a server-jittered Retry-After
hint keep the makespan win without re-synchronizing clients, and what do
these same policies do against an outage rather than congestion (a discarded
sibling implementation of this project had measured outage shapes this one
didnt; these are those measurements, redone on this clock and server). the
outage window is authored like everything else here: the server fails
instantly with 503 over [0, outage), before admission control, so outage
rejections cost the server nothing and tell the client nothing about rate.
recovery hints are the oracle case, the server knows exactly when it comes
back, so the retry-after rows are an upper bound on what compliance can buy;
a real incident's Retry-After is a guess. run everything below with
`npm run start:outage`.

### study 1: jittering the Retry-After hint

same scenario and strategy as the main table's full-jitter+retry-after row;
only the server changes, adding a uniform draw from [0, jitter] ms to every
hint. jitter only ever adds, so a compliant client never arrives before the
token it was promised exists.

| hint jitter | success | att/ok | 429s | makespan | p50 ok | peak/100ms | collide |
|---|---|---|---|---|---|---|---|
| exact | 99.5% | 2.97 | 390 | 9.47s | 56ms | 92 | 12 |
| 50ms | 100.0% | 3.00 | 398 | 15.73s | 58ms | 91 | 2 |
| 100ms | 100.0% | 3.16 | 431 | 13.71s | 115ms | 78 | 2 |
| 200ms | 100.0% | 3.03 | 404 | 11.38s | 85ms | 70 | 2 |
| 500ms | 100.0% | 3.00 | 398 | 11.87s | 293ms | 65 | 2 |

the collide column answers the question at every width: 12-wide exact-hint
collisions drop to 2 the moment the hint carries any jitter at all. the
makespan column looks like it answers the other half too, and thats the trap
this study nearly shipped: one seed's makespan is owned by whichever request
draws a transient 503 late and backs off toward the 10s cap. so the width
comparison gets a seed sweep before any makespan claim:

| seed | makespan exact | collide | makespan 200ms | collide |
|---|---|---|---|---|
| 42 | 9.47s | 12 | 11.38s | 2 |
| 43 | 15.73s | 13 | 17.48s | 2 |
| 44 | 15.69s | 12 | 13.17s | 3 |
| 45 | 15.71s | 12 | 14.23s | 3 |
| 46 | 15.70s | 14 | 14.78s | 2 |
| mean | 14.46s | max 14 | 14.21s | max 3 |

mean makespan 14.21s jittered vs 14.46s exact, a 0.25s difference inside a
9.47s-to-15.73s per-seed spread for exact hints alone. so the answer to the
open question is yes: jitter the hint, the residual herd disappears and no
makespan cost survives the noise. the humbling part is the other direction:
seed 42's 9.47s, the number the table above calls closest to ideal, turns
out to be the best of its 5 seeds, not the typical. the ordering claim
(retry-after closest to ideal, guessing strategies behind) holds, but the
margin quoted from one seed was seed luck. measure across seeds before
quoting a margin.

### study 2: outage recovery

40 clients, 1 request each, all at t=0; the server is hard-down over
[0, outage) then healthy at 20 req/s burst 20. the retry budget (base 100ms,
cap 10s, max 8 retries) can wait at most 22.7s in total, so no guessing
schedule can outlive a 22.7s+ outage; that cliff is structural, not seeded.
outage 503s advertise time-to-recovery, and only the retry-after rows listen.

| success by outage | 1s | 2s | 5s | 10s | 20s | 30s |
|---|---|---|---|---|---|---|
| fixed-100ms | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| exp-no-jitter | 100.0% | 100.0% | 100.0% | 100.0% | 50.0% | 0.0% |
| exp-full-jitter | 100.0% | 100.0% | 95.0% | 67.5% | 0.0% | 0.0% |
| exp-equal-jitter | 100.0% | 100.0% | 100.0% | 100.0% | 5.0% | 0.0% |
| retry-after-exact | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% |
| retry-after-jittered | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% |

detail at the 10s outage:

| strategy | success | attempts | wasted | 429s | rec peak | makespan | drain | give-up p50 | collide |
|---|---|---|---|---|---|---|---|---|---|
| fixed-100ms | 0.0% | 360 | 360 | 0 | 0 | 0.80s | 0.00s | 0.8s | 40 |
| exp-no-jitter | 100.0% | 340 | 280 | 20 | 40 | 22.76s | 12.76s | - | 40 |
| exp-full-jitter | 67.5% | 359 | 332 | 0 | 2 | 18.72s | 8.72s | 7.1s | 1 |
| exp-equal-jitter | 100.0% | 347 | 307 | 0 | 2 | 19.67s | 9.67s | - | 1 |
| retry-after-exact | 100.0% | 133 | 40 | 53 | 54 | 12.17s | 2.17s | - | 40 |
| retry-after-jittered | 100.0% | 82 | 40 | 2 | 7 | 11.89s | 1.89s | - | 1 |

`wasted` = attempts that landed while the service was down. `rec peak` =
peak arrivals/100ms from the recovery instant on. `drain` = makespan minus
outage.

**against an outage, jitter flips from cure to liability.** the main table
crowned jitter for congestion; a hard down inverts it. exp-no-jitter
survives the 10s outage 100.0% because a deterministic schedule cannot spend
its budget early, while full jitter's short draws burn retries during the
outage and only 67.5% survive. equal jitter, whose floor is half the
exponential, holds 100.0% at 10s: under a bounded retry budget the delay
floor is what buys outage survival, the same floor effect the main table
showed as a thinner success tail. and survival isnt just the budget: at 20s,
exp-no-jitter's whole herd still has one attempt left and spends it as a
single 40-wide wall at 22.7s, the burst admits 20, and the other 20 burn
their final attempt on a 429. surviving the outage is not surviving the
recovery.

**the recovery herd is the hint's own makespan problem, and hint jitter
fixes that too.** retry-after-exact tells all 40 clients the same recovery
instant, so its 93 post-recovery attempts arrive as a 54-per-100ms spike
that generates 53 429s. a 1s jittered hint spreads the same recovery into a
7-per-100ms trickle, 2 429s, 82 total attempts against 133, and still drains
faster (1.89s vs 2.17s). compliance also wins on waste: both retry-after
rows spend exactly 40 attempts learning the service is down, the exponential
guessing rows spend 280 to 332, and fixed-100ms spends 360 for nothing.

### study 3: the dead service

40 clients, 3 sequential requests each, against a server that never
recovers: every attempt an instant 503, no hints. nobody can succeed; the
numbers are the cost of finding that out with a per-request retry budget
and no memory between requests.

| strategy | attempts | att/req | makespan | peak att/s | give-up p50 | give-up p99 |
|---|---|---|---|---|---|---|
| no-retry | 120 | 1.0 | 0.00s | 120 | 0.00s | 0.00s |
| fixed-100ms | 1080 | 9.0 | 2.40s | 440 | 0.80s | 0.80s |
| exp-no-jitter | 1080 | 9.0 | 68.10s | 160 | 22.70s | 22.70s |
| exp-full-jitter | 1080 | 9.0 | 49.19s | 205 | 11.33s | 18.56s |

**the retry budget, not the backoff policy, sets total waste.** every
retrying strategy burns exactly 9 attempts per request, 1080 total; backoff
never reduces the bill on a dead dependency, it only chooses the shape.
fixed-100ms hammers 440 attempts/s for 2.40s; exp-no-jitter drips 160/s for
68.10s. and the caller pays in hang time: 22.70s (no jitter) or 11.33s p50
(full jitter) of waiting before hearing "no", after which the next request
starts the same climb from 100ms again. request 3 wastes exactly what
request 1 did. the retry loop has no memory across requests, and thats the
argument for the thing this project deliberately doesnt have yet: a circuit
breaker.

## why typescript

Retry loops, rate limiters, and backoff policies are client SDK territory, and
that code ships in TypeScript at the day job. The interesting engineering
problem is also language-native here: making async retry code deterministic
means injecting a clock instead of calling `setTimeout`, which is exactly how
youd make production retry code testable. The virtual clock drives real
promise-based `await sleep(...)` code, not a callback simulation, so the retry
loop under test is shaped like the retry loop youd actually ship.

## layout

- `src/clock.ts` virtual-time clock: deterministic timer ordering, deadlock detection
- `src/bucket.ts` continuous-refill token bucket (used by both server and pacer)
- `src/backoff.ts` fixed / exponential / full / equal / decorrelated jitter
- `src/server.ts` simulated API: admission control, seeded latency and faults, arrival log
- `src/retry.ts` bounded retry loop with optional Retry-After compliance
- `src/limiter.ts` client-side pacing limiter (waits instead of failing)
- `src/experiment.ts` one strategy vs one fresh server, metrics out
- `src/outage.ts` outage scenarios: waste, recovery spike, drain, give-up latency
- `src/outage-main.ts` the three outage studies above
- `src/percentile.ts` linearly interpolated percentile (port of 02's, same behavior)

The seeded PRNG is imported from `05-token-streaming` rather than duplicated.

## run it

```
npm ci
npm test              # 69 tests
npm start             # the main table
npm run start:outage  # the outage studies
npm run typecheck
```

## fixes

- 2026-08-28 — the p50/p99 columns only ever covered requests that succeeded,
  with nothing in the table saying so, and success rates run 10.5% to 100%
  down that column - no-retry read 40ms while 89.5% of its requests were
  rejected instantly. added `p50 all` over every request, relabelled the old
  columns `p50 ok`/`p99 ok`. no-retry 40ms → 0ms all, fixed-100ms 229ms →
  800ms all, every other row within 37ms of its ok value, no other number
  moved

## open questions

- the herd is one-shot at t=0. a poisson arrival process with a congestion
  spike in the middle would test whether the strategy ordering survives
  steady-state traffic
- full jitter and decorrelated fail 2 and 7 of 200 requests where equal jitter
  fails 0. is the delay floor the real variable? a floor sweep (0%, 25%, 50%
  of exp) at fixed retry budget would isolate it
- pacing is measured at exactly the server rate. a rate sweep (80% to 120% of
  server rate) would find the throughput/429 knee, and adaptive pacing (aimd
  on 429s) is the real-world answer when the server rate is unknown
- 503 retries bypass the pacing bucket by design and cause every leftover 429.
  routing retries through the pacer, and measuring the makespan cost of that
  fairness, is a one-line change with a real trade-off attached
- the virtual clock fires timers one at a time with a full continuation flush
  between. at what simulated scale does that become the bottleneck, and what
  does batching same-instant timers buy?
- study 3 is the argument for a circuit breaker: trip after k consecutive
  failures, probe half-open, and the 1080-attempt bill collapses to roughly
  the trip threshold. the price is false trips during a survivable spike
  like the main table's herd, and both sides are measurable right here
- study 2 recovers to full capacity in one instant; real recoveries ramp.
  whether the server should advertise a reduced rate for the first seconds
  or the clients should spread themselves (study 1's hint jitter, but on
  the recovery side) is a question of which side of the wire owns the herd
- give-up time here is a side effect of the backoff schedule; a deadline
  budget (give up at t=5s regardless of attempts remaining) would decouple
  hang time from backoff shape, and its success cost against these same
  outages is unmeasured
- hint jitter here is in milliseconds; real Retry-After headers quantize to
  whole seconds, and quantization is itself a synchronizer. how much of
  study 1's desynchronization survives 1s granularity?
