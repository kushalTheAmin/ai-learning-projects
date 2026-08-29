# 11 prompt caching

a cost simulator for provider-side prompt caching. it replays seeded multi-turn agent workloads through a simulated prefix cache and prices every request, so you can see exactly which breakpoint placements save money, which ones quietly lose it, and by how much.

everything here is simulated. no model is called and no api key is used. the cache is a from-scratch model of anthropics published caching semantics: exact prefix matching, reads at 0.1x the base input price, writes at 1.25x for the 5 minute ttl and 2x for the 1 hour ttl, free ttl refresh on every read, a minimum cacheable prefix (1024 tokens here, the sonnet-class figure), at most 4 breakpoints per request, and a 20 content-block lookback per breakpoint. the workload is authored and generated from a seeded phrase bank, and tokens are estimated at ~4 chars/token (imported from project 08), not counted by a real tokenizer. so the headline numbers measure the accounting model, not a real bill: they show how the pricing rules interact with traffic shapes, and the ratios are exact consequences of the published multipliers, but absolute dollar figures on real traffic will differ with real token counts and real conversation sizes.

## the concept

prompt caching is a prefix match. the provider caches the rendered request up to each marked breakpoint, and a later request that starts with the exact same bytes reads that prefix at a tenth of the price instead of reprocessing it. the catch is the pricing is asymmetric: a write costs 1.25x normal input. caching is a bet that the prefix will be read again before its ttl runs out. every experiment here is some version of that bet paying off or not.

the cache model lives in `src/cache.ts`: a hit is the longest previously cached prefix of the current request, writes bill only the delta past that hit, entries below the minimum prefix length silently dont cache, and each breakpoint only walks back 20 blocks looking for a prior entry. `src/pricing.ts` turns the billed token classes into dollars, `src/workload.ts` generates the conversations, `src/strategies.ts` places breakpoints, `src/experiment.ts` runs the five experiments.

## run it

```
npm ci
npm run typecheck
npm test
npm start
```

node 20+. no network calls at runtime, everything is offline and deterministic (seed 20260827, pricing $2/MTok input).

## what the numbers say

**1. breakpoint placement, 6 interleaved conversations x 10 turns, 30s mean gap.** no caching bills $0.3184 input. one breakpoint on the static tools+system prefix saves 44.2% ($0.1775, hit rate 49.4%), and the documented agent-loop combination, static breakpoint plus a moving one on the last block, saves 78.0% ($0.0700, hit rate 89.6%). the incremental run shows the healthy signature: uncached drops to 0, reads carry the conversation (142616 tokens), writes stay small (16608 tokens, each turn writing only its own delta).

**2. the volatile header.** same conversations, same incremental breakpoints, but the system prompt now starts with a per-request `session N request M` line. hits go from 59/60 to 0/60 and cost lands at exactly 1.250x of not caching this traffic ($0.3988 vs $0.0700 with a stable header, more than a 5x swing from one line of prompt assembly). the header is extra tokens on every request, so it gets its own no-caching baseline — priced against it, the ratio is the 1.25x write multiplier and nothing else. this is the classic silent invalidator: nothing errors, the bill just goes up, because every request pays the 1.25x write premium on a prefix nobody will ever read back.

**3. one-shot requests.** 40 unique prompts with caching left on bill exactly 1.250x of no caching ($0.1548 vs $0.1239): all 61931 prospective tokens are written, none are ever read. caching is not a default-on flag, it is a bet on repetition, and unique traffic loses the bet by construction.

**4. turn gap vs ttl, 12 turns.** with 1m or 4m between turns the 5m ttl wins (0.246x vs 0.341x for the 1h ttl, whose writes cost 2x for nothing extra, since every read refreshes the timer for free and keeps the entry alive indefinitely). at 8m or 25m gaps the 5m cache expires between every turn and becomes a pure loss, exactly 1.250x, while the 1h ttl still delivers 0.341x. at 70m both expire: 1.250x and 2.000x. the ttl choice is a function of one number, the start-to-start gap between requests sharing the prefix, and picking wrong doesnt degrade gracefully, it flips the sign of the whole feature.

**5. the 20-block lookback.** each breakpoint only walks back 20 content blocks to find a prior cache entry. at 10 blocks per turn the tail breakpoint always finds last turns entry and the naive and spaced strategies price identically (0.340x). at 26 blocks per turn (a tool-heavy agent turn) the tail breakpoint cant see back far enough: hit rate collapses from 77.2% to 15.5%, every turn rewrites the whole history, and the naive strategy costs 1.072x, worse than not caching, while adding one intermediate breakpoint 15 blocks before the tail restores 0.362x. same code, same traffic, $0.1291 against $0.0436, from where two markers sit.

## tradeoffs and where it breaks down

- the 4 chars/token estimate is crude and undercounts non-english text badly (project 04 measured that honestly). every ratio here is estimate-over-estimate so the multiplier arithmetic is exact, but absolute dollars are approximate.
- the simulation bills a write the moment a request arrives. real caches only become readable once the writing response starts streaming, so n identical concurrent requests all pay full price. this simulator would score that fan-out as n-1 hits. concurrency is the biggest unmodeled effect.
- ttl is measured request-start to request-start here, which matches the documented rule, but real generation time eats into the window: a 4 minute generation leaves 1 minute of a 5m ttl. the sweep would shift left under slow generations.
- exact string keys make the cache collision-free but memory-hungry, fine for a simulation, wrong for a real cache, which hashes.
- the workload is authored. real traffic has burstier arrivals, editing of earlier turns (which busts the prefix mid-conversation), and mixed models (caches are model-scoped). none of that is measured here.

## why typescript

this is the day-job side of the portfolio: cache accounting is the kind of thing that ships inside a typescript api gateway or agent runtime, and the project imports the token estimator from 08 and the seeded rng from 05 rather than reimplementing either. strict mode, no `any`, exhaustive small tests on the billing arithmetic, since the whole value of a cost model is that the arithmetic binds.

## fixes

- 2026-08-29 — the volatile header experiment divided by the *stable*
  workload's no-caching cost, so it priced one traffic shape against another
  one's baseline — the header adds 300 tokens the denominator never saw. every
  other experiment already baselines against its own events. each variant gets
  its own baseline now and the volatile row lands on exactly the write
  multiplier: 1.252x → 1.250x. nothing else moved

## open questions

- the spaced-15 strategy spends a third breakpoint to fix the lookback miss. with only 4 slots total, whats the optimal placement policy when turns vary in block count, and can it be computed online from the observed turn shape?
- concurrent identical requests all miss until the first response streams. the documented fix is fire one, await first token, fire the rest. what does that serialization cost in latency vs the duplicate-write cost it saves, as a function of fan-out width?
- request-start ttl accounting means generation time silently shrinks the effective window. at what generation-time distribution does a nominal 5m ttl behave like 1m, and does that flip the ttl sweep verdict?
- the volatile header experiment kills 100% of hits because the header sits at block 1. a volatile block at position k should kill only the cache past k. the cost-of-volatility curve as a function of position is unmeasured here.
- cache hits change cost but also latency (cached prefixes skip prefill). pricing that in needs a latency model per cached vs uncached token, which this simulator doesnt have.
