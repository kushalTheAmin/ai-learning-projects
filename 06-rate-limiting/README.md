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

| strategy | success | attempts | att/ok | 429s | makespan | p50 | p99 | peak/100ms | collide |
|---|---|---|---|---|---|---|---|---|---|
| no-retry | 10.5% | 200 | 9.52 | 179 | 0.07s | 40ms | 56ms | 200 | 0 |
| fixed-100ms | 43.5% | 1333 | 15.32 | 1245 | 3.50s | 229ms | 849ms | 69 | 20 |
| exp-no-jitter | 100.0% | 593 | 2.96 | 393 | 12.90s | 152ms | 6353ms | 61 | 20 |
| exp-full-jitter | 99.0% | 592 | 2.99 | 392 | 14.66s | 56ms | 10636ms | 104 | 1 |
| exp-equal-jitter | 100.0% | 569 | 2.85 | 366 | 11.35s | 108ms | 10601ms | 86 | 1 |
| decorrelated | 96.5% | 615 | 3.19 | 420 | 10.92s | 240ms | 7715ms | 61 | 1 |
| full-jitter+retry-after | 99.5% | 591 | 2.97 | 390 | 9.47s | 56ms | 8908ms | 92 | 12 |
| full-jitter+pacing | 100.0% | 223 | 1.11 | 20 | 16.63s | 40ms | 5611ms | 21 | 1 |

`att/ok` = server-side attempts per successful request. `collide` = the most
retries arriving at the exact same virtual instant.

## what the numbers say

**Synchronization, not volume, is what jitter fixes.** Jitterless exponential
backoff retries in lockstep: the 20 clients rejected at t=0 all come back at
exactly t=100ms, then exactly t=300ms, 20-wide collisions against a bucket
that refills 2 tokens per 100ms. Full jitter never collides more than 1-wide.
But its *peak-window load is higher* (104 vs 61 arrivals/100ms): full jitter
draws from [0, exp), so its mean delay is half the exponential and it retries
sooner. The p50 shows the same trade from the client's side, 56ms vs 152ms.
Jitter doesnt spread load thinner here; it stops the herd from arriving as a
wall.

**Retrying without backing off is the worst of both worlds.** Fixed 100ms
delay burns 15.32 attempts per success, over 5x the work of any exponential
variant, and still fails 56.5% of requests, because 9 attempts spaced 100ms
apart only ever sample ~0.8s of a congestion window that takes ~9s to drain.
The exponential variants all succeed on ~3 attempts per request by reaching
multi-second delays that actually outlive the congestion.

**The server knows best.** Honoring Retry-After (the time until the bucket's
next token) finishes in 9.47s, closest to the 9.0s ideal, while every
guessing strategy takes 10.92 to 14.66s. The hint is deterministic, so it partially
re-synchronizes clients (collide 12), which is why real APIs jitter their
hints or tolerate the residual herd.

**Client-side pacing beats retrying at all.** A shared token bucket that
*waits* before sending, matched to the server's budget, turns 392 rejections
into 20 and 2.99 att/ok into 1.11. But pacing at exactly the server rate
leaves zero headroom, so local queueing stretches the makespan to 16.63s. The
20 leftover 429s are all downstream of the 3 transient 503s: those retries
re-enter without a pacing token, and each stolen server token can bounce a
paced first attempt (0 here; a pinned test shows 1 of 27 on another seed).
Pacing changes *where* requests wait, in your process, not in the retry loop,
and pushes the 429 problem into whatever traffic bypasses the pacer.

**Jitter's cost is a fatter success tail.** No-jitter finishes 100% with p99
6353ms; full jitter fails 2 requests and decorrelated 7, with p99 over 10s: a
short-drawn jitter delay burns a retry cheaply, so an unlucky request can
exhaust all 8 retries before congestion clears. Equal jitter, which floors
every delay at half the exponential, keeps 100% success with fewer attempts
than either. Under a bounded retry budget, the floor matters.

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
- `src/percentile.ts` linearly interpolated percentile (port of 02's, same behavior)

The seeded PRNG is imported from `05-token-streaming` rather than duplicated.

## run it

```
npm ci
npm test        # 47 tests
npm start       # the table above
npm run typecheck
```

## open questions

- the herd is one-shot at t=0. a poisson arrival process with a congestion
  spike in the middle would test whether the strategy ordering survives
  steady-state traffic
- full jitter and decorrelated fail 2 and 7 of 200 requests where equal jitter
  fails 0. is the delay floor the real variable? a floor sweep (0%, 25%, 50%
  of exp) at fixed retry budget would isolate it
- retry-after re-synchronizes clients (collide 12) because the hint is
  deterministic. does a server-jittered hint keep the makespan win without
  the collisions?
- pacing is measured at exactly the server rate. a rate sweep (80% to 120% of
  server rate) would find the throughput/429 knee, and adaptive pacing (aimd
  on 429s) is the real-world answer when the server rate is unknown
- 503 retries bypass the pacing bucket by design and cause every leftover 429.
  routing retries through the pacer, and measuring the makespan cost of that
  fairness, is a one-line change with a real trade-off attached
- the virtual clock fires timers one at a time with a full continuation flush
  between. at what simulated scale does that become the bottleneck, and what
  does batching same-instant timers buy?
