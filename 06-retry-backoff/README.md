# 06 — retry policies under failure: exponential backoff and jitter, measured

Everything here is simulated: the "API" is a token-bucket rate limiter with an
optional scripted outage window, the clients are scripted loops, and time is a
virtual clock that jumps between events. No network is touched. That means the
headline numbers measure how retry *policies* behave under one specific,
authored contention model — synchronized cold starts, a hard outage with
integer Retry-After hints, a dead dependency. They demonstrate the mechanics
(herd synchronization, wasted burst capacity, retry amplification) exactly and
reproducibly; they do not predict throughput or latency of any real API, whose
failures arrive with burstier timing, partial degradation, and server behavior
this model doesn't have.

## The question

Every SDK wraps retries for you, and the defaults hide a real decision: retry
*when*? Retrying immediately turns one failure into a self-inflicted DDoS.
Backing off exponentially without jitter keeps every client's schedule
identical, so the herd that failed together retries together, forever.
This project builds the standard policy family and measures what each one
actually costs under three failure shapes.

## Policies

| policy | delay after attempt *n* fails |
|---|---|
| `immediate` | 0 |
| `fixed(d)` | d |
| `expo-no-jitter` | min(cap, base·2ⁿ⁻¹) |
| `expo-equal-jitter` | half that, plus uniform(0, half) |
| `expo-full-jitter` | uniform(0, min(cap, base·2ⁿ⁻¹)) |
| `decorrelated-jitter` | min(cap, uniform(base, 3·previous delay)) |
| `retry-after-exact` | the server's Retry-After hint, verbatim |
| `retry-after-jitter` | the hint, plus a full-jittered exponential term |

base = 1s, cap = 30s throughout. Giving up is the client's job — every client
has a hard budget of `maxAttempts` and a non-finite delay (a Retry-After from
a server with zero capacity) is treated as a hard failure immediately. That
keeps every policy comparable under the same failure budget.

## Scenario 1 — cold-start thundering herd

500 clients wake at t=0 against a 50 req/s bucket with burst 50 (a deploy
restart, a cache flush, a popular cron minute). Ideal makespan ≈ 9s.
`maxAttempts=10`, seed 1. "collision" is the largest number of *retries*
arriving at exactly the same simulated instant — first attempts don't count,
because the policy has no say over them.

| policy | success | attempts | p50 | p95 | makespan | collision | capacity used |
|---|---|---|---|---|---|---|---|
| immediate | 10.0% | 4550 | 0.0s | 0.0s | 0.0s | 4050 | – |
| fixed(2s) | 100% | 2750 | 9.0s | 18.0s | 18.0s | 450 | 56% |
| expo-no-jitter | 100% | 2750 | 23.0s | 151.0s | 151.0s | 450 | 7% |
| expo-equal-jitter | 100% | 1785 | 4.7s | 12.9s | 14.0s | 1 | 71% |
| expo-full-jitter | 100% | 1905 | 4.0s | 11.3s | 19.9s | 1 | 50% |
| decorrelated-jitter | 100% | 1285 | 4.1s | 9.3s | 15.3s | 1 | 66% |

What the table says:

- **Immediate retry is a 90% failure rate.** The burst serves 50 clients; the
  other 450 burn all ten attempts in the same instant and give up at t=0.
  4550 requests, 450 failures, zero time spent waiting — the worst of every
  column at once.
- **Exponential backoff without jitter is *worse than a fixed 2s delay* here**
  — same 2750 attempts, but p95 goes from 18s to 151s. The waves stay
  perfectly synchronized (450 retries colliding at the same instant) while
  the gaps between waves double past the point of usefulness: the bucket
  refills to its 50-token cap in 1 second and then throws capacity away for
  the rest of the 30s gap. 7% of refilled capacity ever serves a request.
  Backoff timing spreads *when* load arrives; it cannot spread load that
  still arrives together.
- **Any jitter collapses collisions from 450 to 1** and cuts attempts by
  30–53%. The jittered herd drains at 14–20s makespan, near the 9s ideal.
- **Decorrelated jitter is the quiet winner** on this workload: fewest
  attempts (1285 vs 1905 full-jitter) and best p95 (9.3s), because basing the
  next delay on the previous one adapts spread to how long a client has
  already been failing.

The "collision" column is also a measurement lesson: per-second arrival
buckets can't see herd synchronization at all — sub-second jittered retries
land in the same 1s bucket as the wave they left, so full jitter's *bucketed*
peak (1044/s) reads worse than no-jitter's (500/s) while its same-instant
collision count is 1 vs 450. The first metric I wrote gave the wrong answer;
the test that asserted "jitter lowers peak arrivals" failed and forced the
better metric.

## Scenario 2 — outage recovery with Retry-After

200 clients arrive over 5s; the server 503s everything until t=10, then
recovers at 40 req/s (burst 40). The server sends integer Retry-After hints,
like a real 429/503. Seed 2.

| policy | success | attempts | p50 | p95 | makespan | peak arrivals/s |
|---|---|---|---|---|---|---|
| retry-after-exact | 100% | 648 | 10.0s | 11.0s | 15.0s | 200 |
| retry-after-jitter | 100% | 494 | 9.3s | 12.4s | 14.5s | 105 |
| expo-no-jitter | 100% | 920 | 15.0s | 15.0s | 18.0s | 120 |
| expo-full-jitter | 100% | 1122 | 11.1s | 25.2s | 37.1s | 154 |

- **Obeying Retry-After to the letter re-creates the herd at the recovery
  instant**: all 200 clients are told "back at t=10" and all 200 arrive in
  that second. Here capacity absorbs it in a few 1-second rounds; against a
  server still warming up, that stampede is the classic re-outage.
- **Hint + jitter dominates**: fewest attempts (494), best makespan, and the
  recovery-second arrivals cut roughly in half.
- **Server-blind exponential backoff pays for its ignorance in the tail**:
  full jitter's p95 is 25s and makespan 37s because clients that had backed
  off toward the 30s cap sleep through the recovery. The hint is information;
  throwing it away costs real latency.

## Scenario 3 — dead service: the load you add while it's down

100 clients, zero capacity all run, `maxAttempts=10`, seed 3. Everyone fails;
the only question is how hard the dying dependency gets hammered on the way.

| policy | requests in first 5s | peak arrivals/s | last give-up at |
|---|---|---|---|
| immediate | 1000 | 1000 | 0.0s |
| fixed(2s) | 300 | 100 | 18.0s |
| expo-no-jitter | 300 | 100 | 151.0s |
| expo-full-jitter | 409 | 230 | 122.6s |
| decorrelated-jitter | 254 | 100 | 205.1s |

Backoff is also *mercy*: immediate retry fires its full 1000-request budget
into the corpse in one instant, while backoff policies send a quarter of that
in the first five seconds and stretch the rest over minutes. The flip side is
honest too — backoff means a client can take 2–3 minutes to *report* hard
failure. That tail is the argument for a circuit breaker, which this project
deliberately does not implement (see open threads).

## Design notes

- **Virtual clock** (`src/sim.ts`): a binary-heap event queue keyed by
  (time, insertion order). Runs hours of simulated traffic in milliseconds,
  bit-for-bit reproducibly — the integration suite asserts two runs with the
  same seed produce identical metrics, and that changing the seed changes
  the outcome.
- **Token bucket** (`src/server.ts`): continuous refill at `ratePerSec` up to
  `burst`, integer Retry-After hints (`ceil`, min 1s) like a real header, and
  an arrival histogram plus a same-instant retry-collision counter, because
  those two metrics disagree in exactly the way scenario 1 shows.
- **The PRNG is imported from `05-token-streaming`** (mulberry32) rather than
  rewritten — the repo rule is one implementation per mechanism per language.
- All delays and clocks are in seconds of simulated time; nothing sleeps.

## Run it

```bash
npm ci
npm test        # 47 tests: heap ordering, refill math, policy bounds, herd behavior
npm run typecheck
npm start       # prints the three scenario tables above
```

Node 20+. No network, no API keys.

## What I'd measure next

- A circuit breaker in front of scenario 3: failure-rate threshold, open/half-
  open states, and what it does to time-to-report vs load-on-dependency.
- Retry budgets (e.g. retries ≤ 10% of requests, client-wide) — per-client
  `maxAttempts` caps one client, not the fleet.
- Bursty Poisson arrivals instead of the all-at-once herd; the all-at-once
  case is the worst case, not the common one.
