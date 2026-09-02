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
argument for a circuit breaker, which the breaker extension below builds
and prices.

## the breaker extension: trip, cool down, probe

the dead-service study priced the missing circuit breaker, so this extension
builds one and measures both sides of the trade. the breaker is the classic
three-state machine: closed counts consecutive counted failures, at the
threshold k it opens and rejects callers without touching the wire, and
after a cooldown it admits exactly one half-open probe whose success closes
it and whose failure restarts the cooldown. it sits between the retry loop
and the wire in one of two modes. fail-fast ends the request the moment the
gate rejects, which is what production breakers do. wait sleeps until the
probe window and tries again, spending no budget on the wait itself.

scope is part of the design: per-client gives each client its own memory
across its sequential requests, shared gives every client one view of the
dependency, like one process with many workers. and the breaker takes a
predicate for what counts as a failure; whether a 429 counts turns out to be
the whole story in study 3. run everything below with `npm run start:breaker`.

### study 1: the dead service, now with a breaker

same scenario as the outage extension's study 3 (40 clients x 3 sequential
requests, every attempt an instant 503, no hints), full-jitter retries. the
no-breaker row is that study's exp-full-jitter row rerun through this
harness, and it reproduces exactly: 1080 attempts, 49.19s makespan.

| strategy | wire att | att/req | rejected | trips | probes | makespan | give-up p50 req1 | later reqs |
|---|---|---|---|---|---|---|---|---|
| no-breaker | 1080 | 9.0 | 0 | 0 | 0 | 49.19s | 11.49s | 11.33s |
| k=3 fail-fast | 120 | 1.0 | 120 | 40 | 0 | 0.65s | 0.33s | 0.00s |
| k=5 fail-fast | 200 | 1.7 | 120 | 40 | 0 | 2.53s | 1.40s | 0.00s |
| k=5 wait | 1080 | 9.0 | 657 | 40 | 880 | 71.86s | 13.86s | 22.83s |
| k=5 shared | 40 | 0.3 | 120 | 1 | 0 | 0.10s | 0.04s | 0.00s |

**fail-fast is what collapses the bill.** k=5 spends 200 wire attempts
against the no-breaker 1080, 81.5% of the traffic gone, and the split
columns show where the saving lives: request 1 pays 5 attempts to discover
the outage (1.40s p50 of hang), requests 2 and 3 inherit the open breaker
and hear "no" in 0.00s instead of 11.33s. thats the open thread's claim
measured: the bill collapses to roughly the trip threshold per client.

**wait mode does not shrink the bill.** 1080 attempts, same as no breaker,
because the budget is counted in attempts and every probe window mints
another probe until the budget is gone. worse, probes fire at
max(backoff, cooldown), so callers hang longer: 22.83s p50 on later
requests vs 11.33s plain. against a dead service, waiting politely is
still waiting for nothing.

**the shared breaker's floor is the concurrency width, not k.** all 40
clients are already in flight when it trips, so 40 attempts land before the
gate closes; a breaker cannot recall requests it already admitted. after
that one trip everything is rejected without touching the wire, and the
whole run is over in 0.10s.

### study 2: the survivable outage

40 clients x 1 request at t=0, hard-down over [0, outage) then healthy,
equal-jitter retries, the schedule that survived every outage up to 10s in
the outage extension. hints advertised but not respected, so the breaker is
the only thing changing between rows.

| success by outage | 1s | 2s | 5s | 10s | 20s | 30s |
|---|---|---|---|---|---|---|
| no-breaker | 100.0% | 100.0% | 100.0% | 100.0% | 5.0% | 0.0% |
| k=5 fail-fast 2s | 77.5% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| k=5 wait 2s | 100.0% | 100.0% | 100.0% | 100.0% | 22.5% | 0.0% |
| k=5 wait 5s | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 0.0% |

detail at the 5s outage:

| strategy | success | wire att | wasted | probes | makespan | give-up p50 |
|---|---|---|---|---|---|---|
| no-breaker | 100.0% | 311 | 271 | 0 | 11.06s | - |
| k=5 fail-fast 2s | 0.0% | 200 | 200 | 0 | 2.81s | 2.25s |
| k=5 wait 2s | 100.0% | 281 | 241 | 81 | 9.66s | - |
| k=5 wait 5s | 100.0% | 251 | 200 | 40 | 8.75s | - |

**fail-fast turns a survivable outage into a lost one.** at 5s the plain
schedule lands 100.0% and the fail-fast breaker 0.0%, giving up at 2.25s
p50 with recovery 2.8s away. even the 1s outage keeps only 77.5%: whoever
burns 5 attempts before recovery is done for. the dead-service saving and
this cliff are the same behavior pointed at different futures, and the
breaker cannot know which future its in.

**wait mode dodges the cliff and still wastes less.** it keeps every outage
the plain schedule survives, on fewer wire attempts (281 and 251 vs 311 at
5s), because a tripped breaker sends one probe per window instead of a
herd of backoffs.

**the cooldown is a delay floor, and the floor is what survival is made
of.** probes fire at max(backoff, cooldown), so a longer cooldown stretches
the same 9-attempt budget over a longer horizon: at the 20s outage the
plain schedule keeps 5.0%, wait-2s 22.5%, wait-5s 100.0%. this is the
outage extension's equal-jitter-vs-full-jitter finding again from the other
side: what outlives an outage is not how many attempts you have but how
late your schedule can still be trying. nobody outlives 30s. the budget
still ends.

### study 3: false trips on the healthy herd

the main table's herd with the main table's best guessing strategy,
full-jitter+retry-after. the server is fine; nearly every failure is a 429
the herd caused itself, plus 2% transient 503s. the no-breaker row
reproduces the main table row exactly: 99.5%, 591 attempts, 9.47s.

| strategy | success | wire att | 429s | trips | fast-fail | makespan |
|---|---|---|---|---|---|---|
| no-breaker | 99.5% | 591 | 390 | 0 | 0 | 9.47s |
| k=3 counts 429 | 15.5% | 157 | 125 | 38 | 169 | 0.74s |
| k=5 counts 429 | 29.0% | 299 | 240 | 33 | 142 | 2.34s |
| k=5 503s only | 99.5% | 591 | 390 | 0 | 0 | 9.47s |
| k=5 shared 429 | 10.0% | 40 | 20 | 1 | 180 | 0.10s |

**counting 429s makes herd congestion look like a dead dependency.** at
t=0, 20 of 40 clients draw a 429 on their first attempt, and under
contention streaks of them come fast: k=3 trips 38 times and fails 169
requests fast on a server that is up the whole time, 15.5% success. k=5 is
gentler only in degree, 33 trips, 29.0%. a 429 is the server saying "youre
too fast", and the breaker hears "im dead".

**counting only 503s, the breaker is free.** 0 trips and the run matches
the no-breaker baseline to the attempt, 591 vs 591, because 2% transient
faults cannot produce 5 consecutive counted failures. the false-trip cost
the open thread asked about is not a tax you pay everywhere; it is a
classification bug you can just not write. rejection is backpressure,
failure is damage, and the breaker should only count the second.

**scope multiplies the blast radius.** the shared 429-counting breaker sees
the herd's rejections as one failure streak, trips once, and takes the
whole run to 10.0% success in 0.10s. per-client false trips cost one
client's requests; shared false trips cost everyone's. sharing the breaker
is only as safe as the failure predicate feeding it.

### what the extension says as one sentence

a circuit breaker is a bet that the present failure is permanent, so it
pays exactly where thats true (the dead service, 81.5% of the traffic
saved) and charges exactly where its false (the 5s outage, 100% to 0%;
the healthy herd, 99.5% to 15.5% when 429s count), which is why the
failure predicate and the cooldown, not the threshold, are the knobs that
matter.

## the pacing extension: the knee, then throwing the number away

the base study paced at exactly the server rate and blamed the leftover 429s
on the 503-retry bypass. two threads were open: where is the throughput/429
knee as the pacing rate sweeps past the budget, and what do you do when the
budget isnt a number you know. part 1 sweeps fixed pacing from 80% to 120%
of a known 20 req/s budget under steady closed-loop load. part 2 deletes the
knowledge: the server tightens from 20 req/s to 8 req/s mid-run, and an aimd
controller (additive increase, multiplicative decrease, the tcp congestion
shape applied to request pacing) has to find both numbers by probing. its
measured against fixed pacers at each phase's correct rate and against an
oracle that follows the server's schedule exactly.

new machinery: the token bucket takes `setRate` (owed tokens accrue at the
old rate first, so a rate change never rewrites the past), the server takes
a rate schedule fired at exact virtual instants, and `src/adaptive.ts` is
the aimd pacer. rate grows by +2 req/s per second of clock time, any 429
cuts it x0.6, and a 1s hold-off makes the burst of 429s from one overshoot
count as one congestion event instead of five cuts. first attempts go
through the pacer, retries re-enter unpaced (the base study's contract),
and every 429, paced or not, feeds the controller.

### part 1: the sweep (`npm run start:pacing`, seed 42)

```
pacing      % of srv   success   attempts   att/ok    429s   makespan    ok/s
-----------------------------------------------------------------------------
unpaced            -     98.0%       2186     2.79    1391     43.58s   17.99
paced-16       80.0%    100.0%        807     1.01       0     48.77s   16.40
paced-18       90.0%    100.0%        810     1.01       0     43.38s   18.44
paced-19       95.0%    100.0%        817     1.02       3     41.10s   19.47
paced-20      100.0%     98.9%        899     1.14      96     41.05s   19.27
paced-21      105.0%     98.4%       1936     2.46    1142     40.90s   19.24
paced-22      110.0%     98.1%       1958     2.49    1166     43.37s   18.10
paced-24      120.0%     98.4%       1995     2.53    1198     39.48s   19.94
```

below the budget the client rate is the throughput: paced-16 delivers 16.40
ok/s with 0 rejections, pure client-bound. above it, throughput flatlines
while waste climbs, paced-21 at 1142 429s and 2.46 att/ok against 1.02 at
95%. the knee is sharp and it isnt free to stand on: pacing at exactly 100%
leaves zero headroom for the 503-retry bypass, so a 2.0% transient fault
rate cascades into 96 429s and 98.9% success while paced-19 takes 3 429s at
100.0% success. the operating point this table argues for is 95%, not 100%.

### part 2: the budget drops mid-run

20 clients x 50 requests, server 20 req/s until t=30s then 8 req/s. aimd
starts at 4 req/s knowing nothing. ideal makespan 77.5s.

```
strategy     success   attempts   att/ok   429 ph1   429 ph2   ok/s ph1   ok/s ph2   makespan
---------------------------------------------------------------------------------------------
unpaced        96.2%       3280     3.41      1281      1023      20.23       7.56     76.94s
fixed-20       97.4%       2091     2.15        71      1034      20.33       7.52     78.39s
fixed-8       100.0%       1010     1.01         0         0       8.63       8.01    122.55s
oracle         98.9%       1088     1.10        71        17      20.33       7.97     77.54s
aimd           99.9%       1189     1.19         4       177      18.30       8.04     85.99s
```

the aimd rate trace, sampled every 5s (34 cuts taken over the run):

```
t=0s 4.0  t=5s 14.0  t=10s 24.0  t=15s 13.8  t=20s 23.8  t=25s 23.4  t=30s 23.6  t=35s 5.7  t=40s 9.4  t=45s 7.8  t=50s 6.0  t=55s 7.9  t=60s 9.8  t=65s 7.7  t=70s 10.2  t=75s 8.0  t=80s 10.0  t=85s 7.8
```

reading it:

- every fixed rate is wrong in one phase. fixed-20 is clean until the drop
  (71 phase-1 429s) then pays 1034 429s and fails 2.6% of its requests to
  retry burnout. fixed-8 never gets rejected and never fails, but leaves
  11.37 req/s of phase-1 capacity unused and takes 122.55s, half again the
  ideal
- aimd knows neither rate and pays a 10.9% makespan tax over the oracle
  (85.99s vs 77.54s). the probing bill is 181 429s against unpaced's 2304.
  the tax lives almost entirely in phase 1 (18.30 vs 20.33 ok/s, the ramp
  from 4 req/s plus the sawtooth troughs), not phase 2 (8.04 vs 7.97): once
  converged, probing costs nearly nothing, and the trace shows convergence
  to the new 8 req/s budget within one 5s sample of the drop
- the surprise: the informed client is not the safe one. the oracle paces
  at exactly 100% of the advertised rate and inherits part 1's zero-headroom
  fragility, failing 1.1% of requests where aimd fails 0.1%. the sawtooth's
  troughs are accidental headroom that lets 503 retries land without
  cascading. knowing the rate and standing exactly on it is worse for
  success rate than not knowing it and oscillating underneath it

one sentence: the knee at 100% is sharp on the throughput side and fragile
on the success side, so a fixed pacer should stand at 95%, and when the
budget is unknown or moving, aimd buys convergence within seconds for a
~11% makespan tax and a 429 bill an order of magnitude under unpaced

## the header extension: reading the budget off the wire

the pacing extension left a thread open: the 429 is one bit of feedback, but
real apis also send RateLimit headers. so the server now optionally attaches
`limitPerSec` and `remaining` (whole tokens, floored the way real headers
quantize) to every response that reaches the application, snapshotted at
response write time. outage 503s carry nothing, a dependency that dies before
admission control tells you nothing about its rate. two new clients read them:

- `hdr-limit` trusts the limit header: every response sets the pacing rate to
  headroom x advertised limit
- `hdr-remaining` trusts nothing but the remaining count. over any window
  where the bucket never touches its cap, remaining_end minus remaining_start
  plus admissions observed in the window is exactly the refill, whatever the
  drain was. the regimes are asymmetric: an empty bucket is fully informative
  (every refilled token gets taken and counted), a full bucket is censored
  (refill discarded at the cap leaves no trace). censored windows still carry
  one bit, capacity is at least my send rate, so they drive an additive probe
  (2 req/s per second, same as aimd) instead of an estimate update

both start blind at 4 req/s like aimd. one honesty note: turning headers on
makes the server refill its bucket at extra instants, which changes the
floating point accumulation path, so the aimd reference row here differs in
its last digits from the pacing table (85.99s there, 86.06s here, 177 phase-2
429s there, 195 here). same configuration, same dynamics, different rounding
path; each table reproduces itself exactly.

### part 1: the drop scenario, now with headers (`npm run start:headers`, seed 42)

```
strategy         success   attempts   att/ok   429 ph1   429 ph2   ok/s ph1   ok/s ph2   makespan
-------------------------------------------------------------------------------------------------
unpaced            96.2%       3280     3.41      1281      1023      20.23       7.56     76.94s
oracle             98.9%       1088     1.10        71        17      20.33       7.97     77.54s
aimd              100.0%       1207     1.21         4       195      18.30       8.05     86.06s
hdr-limit         100.0%       1011     1.01         0         0      20.10       8.03     79.47s
hdr-remaining      99.1%       1269     1.28         0       269      18.03       8.10     85.57s
hdr-remain-95     100.0%       1011     1.01         0         0      17.57       7.99     89.23s
```

- trusting the limit header cuts aimds 11.0% makespan tax over the oracle to
  2.5% and its 199 429s to zero. one response converts the unknown-budget
  problem into the oracles problem. the residual 2.5% is the blind 4 req/s
  start before the first response lands
- the estimator at full throttle was the surprise. it recovers almost none of
  the makespan tax (10.4%, 85.57s) and takes 269 429s, more than aimds 199.
  the makespan cost is the discovery ramp both share, but the 429s are a
  different mechanism: aimds sawtooth spends most of its time below the
  budget and pays in bursts at the peaks, while an estimator that locks onto
  exactly 8 req/s and paces at 100% of it grazes the limit continuously. its
  trace sits at 7.7 to 8.4 for the whole second phase, and every wobble above
  8.0 is a 429
- the production shape is estimator plus margin: `hdr-remain-95` paces at 95%
  of the estimate and takes zero 429s, the entire sawtooth skipped, at 89.23s
  (3.7% over aimd). so the thread's answer is: remaining alone recovers the
  429 bill entirely, recovers none of the makespan tax, and the two answers
  point in opposite directions. which one you want depends on what a 429
  costs upstream of you

### part 2: pricing the margin

oracle and hdr-limit swept from 85% to 100% headroom on the same drop
scenario, plus one control row, the 100% oracle behind a burst-5 pacing
bucket instead of burst-20:

```
strategy        headroom   success   failed    429s   att/ok   makespan
-----------------------------------------------------------------------
oracle-85            85%    100.0%        0       0     1.01     99.16s
oracle-90            90%    100.0%        0       0     1.01     91.16s
oracle-95            95%    100.0%        0       3     1.01     83.97s
oracle-100          100%     98.9%       11      88     1.10     77.54s
oracle-100-b5       100%    100.0%        0       0     1.01     79.42s
hdr-limit-85         85%    100.0%        0       0     1.01    101.29s
hdr-limit-90         90%    100.0%        0       0     1.01     93.18s
hdr-limit-95         95%    100.0%        0       0     1.01     86.00s
hdr-limit-100       100%    100.0%        0       0     1.01     79.47s
```

the sweep answered a different question than the one i asked it. the pacing
study read the 100% oracles 1.1% failure rate as zero-headroom fragility, so
the plan was to price the margin that fixes it. the control row says the
fragility was never about the average rate: the identical informed rate
behind a burst-5 bucket fails nothing and takes zero 429s. the knife edge
lives in the 20-wide t=0 burst that a burst-20 pacing bucket admits all at
once, landing the whole herd before the first fault retry has anywhere to
go. hdr-limit-100 is clean for the same reason, its bucket bursts 5. two
fixes, priced: 5% of margin costs 6.43s of makespan, shaping the burst costs
1.88s. the burst is the cheaper fix, and past it, margin prices as pure
throughput, roughly 7s per 5% step on this workload, buying nothing
measurable

### part 3: the budget rises, and nobody tells you

server at 8 req/s until t=30s, then 20. a raise never sends a 429, so the
429-driven controller and the remaining-driven one alike must probe for it:

```
strategy         success   attempts   att/ok   429 ph1   429 ph2   ok/s ph1   ok/s ph2   makespan
-------------------------------------------------------------------------------------------------
oracle             99.1%       1117     1.13        16        99       8.57      16.30     75.03s
aimd              100.0%       1068     1.07        47         7       8.57      19.53     68.05s
hdr-limit         100.0%       1014     1.01         0         0       8.13      20.00     67.81s
hdr-remaining     100.0%       1014     1.01         0         0       8.20      19.51     68.66s
```

- hdr-limit reads the raise off the next response (67.81s); aimd (68.05s) and
  hdr-remaining (68.66s) climb at 2 req/s per second and reach the new budget
  about 6 seconds late, which this backlog absorbs into under a second of
  extra makespan. the difference is what the probing spends: aimd buys its
  ceiling with 429s (54 of them, 20 cuts), the estimator probes on censored
  full-bucket windows and re-locks from refill arithmetic the moment the
  bucket drains, taking zero
- the perfectly informed oracle is the slowest row and the only one that
  fails requests (75.03s, 9 failed). pacing at 100% of a known budget leaves
  fault retries nowhere to land, and the retry burnout tail stretches its
  makespan past every adaptive client whose slack is accidental headroom.
  part 2 already named the deeper cause, the burst-20 bucket, but the lesson
  survives: perfect information about the rate is not a strategy, its one
  input to one

one sentence: if the server tells you the limit, believe it and keep 5% or a
demand-shaped burst in hand; if it only tells you whats left, you can recover
the whole 429 bill but not the discovery ramp, because remaining-token
arithmetic only teaches while the bucket is busy.

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
- `src/breaker.ts` circuit breaker: consecutive-failure trip, cooldown, half-open probe
- `src/breaker-retry.ts` the retry loop behind a breaker gate, fail-fast and wait modes
- `src/breaker-study.ts` breaker scenarios: per-client or shared scope, failure predicate
- `src/breaker-main.ts` the three breaker studies above
- `src/adaptive.ts` aimd pacer: additive increase over time, multiplicative cut on 429, hold-off dedupe
- `src/pacing-study.ts` pacing scenarios: rate schedules, phase-split metrics, adaptive rate trace
- `src/pacing-main.ts` the sweep and the mid-run drop studies above
- `src/header-pacer.ts` header-informed pacer: trust-limit mode and the remaining-only refill estimator with cap-censoring probe
- `src/header-main.ts` the header studies: gap recovery, headroom sweep, silent raise
- `src/percentile.ts` linearly interpolated percentile (port of 02's, same behavior)

The seeded PRNG is imported from `05-token-streaming` rather than duplicated.

## run it

```
npm ci
npm test               # 139 tests
npm start              # the main table
npm run start:outage   # the outage studies
npm run start:breaker  # the breaker studies
npm run start:pacing   # the rate sweep and the aimd studies
npm run start:headers  # the header studies
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
- aimds additive increase is clocked on time, not on sends. tcp grows per
  ack; this pacer would balloon to max over an idle stretch and pay the whole
  rediscovery on the next burst. gating growth on traffic actually flowing is
  the fix and its cost is unmeasured
- increase +2 and cut x0.6 were picked once, not swept. the increase/decrease
  plane has a stability against throughput frontier and this point's position
  on it is unknown
- the headers here are truth from the servers own bucket, one latency stale
  at worst. real multi-tenant apis show you a remaining that other tenants
  drain invisibly between your responses, which turns the estimators exact
  admission count into a lower bound. how fast the estimate degrades as the
  invisible share grows is measurable by splitting this harness's traffic
  into an observed and an unobserved client pool
- the estimators headroom response is not monotonic: 95% takes 0 429s on the
  drop scenario but 90% takes 55, because pacing lower pushes the bucket into
  the censored cap regime more often and the probe then overshoots. the
  probe/estimate boundary (capSlackTokens, and probe rate) has its own
  stability frontier nobody swept
- a server burst smaller than capSlackTokens can never be seen at its cap
  (remaining is snapshotted after the take), so the probe never engages and
  the estimator settles at its drain rate. an adaptive slack derived from the
  observed remaining distribution would remove the constant
- hdr-limit trusts the header instantly and completely. a lying or lagging
  limit header (advertised 20, enforced 8) would make it the fixed-20 row
  from the pacing study; a trust policy that cross-checks the limit against
  remaining-delta arithmetic gets both signals and is unbuilt
- cuts fire on 429s from retries of requests sent before the last cut, stale
  feedback tcp avoids by cutting once per window of its own sends. per-epoch
  attribution (only cut on 429s of attempts launched since the last cut) is
  unmeasured
- 503 retries bypass the pacing bucket by design and cause every leftover 429.
  routing retries through the pacer, and measuring the makespan cost of that
  fairness, is a one-line change with a real trade-off attached
- the virtual clock fires timers one at a time with a full continuation flush
  between. at what simulated scale does that become the bottleneck, and what
  does batching same-instant timers buy?
- the breaker extension counts consecutive failures; the standard production
  alternative is an error rate over a rolling window, which a burst of
  parallel workers cannot trip with one bad streak. rerunning these three
  studies with a rolling-window breaker would say what the window buys and
  what it delays
- half-open here admits exactly one probe and closes on one success. real
  breakers ramp: a probe quota, close on a success rate. against study 2's
  recovery herd, the quota is a knob between re-tripping on the recovery
  spike and starving the herd through a needle-width gate
- wait mode showed the cooldown acting as a delay floor (the 20s outage
  column: 5% plain, 100% with 5s cooldowns), which is the floor-sweep
  question above wearing a breaker costume. sweeping the floor directly at
  fixed budget, no breaker involved, would separate floor from breaker
- fail-fast bounds hang time the way the deadline-budget idea below would;
  a wall-clock deadline with no breaker on the same outage grid would
  separate "stop early" from "remember across requests", the two things a
  breaker bundles
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
