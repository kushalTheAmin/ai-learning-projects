# 08 agent tool loop

an agent loop with zod-validated tool calling and a hard retry/failure policy, run
over 25 scripted tasks to price what malformed tool args actually cost in model
calls, tokens, dollars and latency. plus a drift study over 10 more tasks where
the model mutates its broken call every round, asking what a loop guard should
key on: exact call identity, or the zod issue signature.

everything model-shaped here is simulated. the "model" is a scripted intent list
per task: the tool calls a competent model would make, each optionally wrapped in
an authored flaw (string where a number belongs, missing field, extra field,
wrong tool name) and a correction rule saying how many validation-feedback rounds
it takes to emit the right call. latency runs on the virtual clock from
06-rate-limiting, tokens are estimated at ~4 chars per token, and the flaky
fetch tool fails with authored 503s. so the headline numbers measure the loop
policies against the failure modes i wrote, not any real model's failure rates.
what they do demonstrate is the mechanics: how each policy spends its budget when
args go wrong, and how the costs separate. what they dont demonstrate is how
often real args go wrong, or whether real models correct after one zod error.

## the idea

a tool-calling agent is a loop: model emits a call, runtime validates and runs
it, result goes back in, repeat until a final answer. every step can go wrong in
a way that costs money, so the loop needs hard edges: a budget on model calls, a
cap on how many times you feed a validation error back, and a guard against the
model repeating the exact same broken call forever. this project compares three
stances:

- `strict`: first invalid call kills the task. validation as a gate
- `feedback`: send the zod error message back to the model, up to 6 rounds per
  intent
- `guarded`: same feedback, plus abort once the identical invalid call shows up a
  third time

the guard only counts invalid emissions. calling the same tool twice with the
same valid args is normal agent behavior (task `dup-calls` pins that), so a
guard keyed on all repeats would be a false-positive machine.

## run it

```
npm ci
npm run typecheck
npm test
npm start
```

no api key, no network. node 20+. imports the virtual clock, backoff, bounded
retry and percentile from 06-rate-limiting and the seeded prng from
05-token-streaming rather than reimplementing them.

## numbers

```
policy    ok     model  wasted  tool   tokens-in  tokens-out  cost     mean-ms  p95-ms
strict   10/25     37      15     12       1052         889  $0.0165     1410    2573
feedback 22/25     82      36     24       7323        1872  $0.0500     2750    5659
guarded  21/25     68      24     23       3978        1579  $0.0356     2341    2861
```

strict completes only the 10 tasks whose first emission was already valid; all
15 flawed tasks die on the spot. feedback recovers 12 of them, everything except
the 3 stubborn tasks that never correct. guarded gives one back: a slow
corrector that needs 3 feedback rounds emits the same broken call 3 times first,
so the guard kills a task the feedback policy would have completed. that is the
real tradeoff, not a free lunch: the guard cannot tell a stubborn model from a
slow one until the identical third emission, and it fires on both.

what each flaw class costs under the guarded policy, per task against the same
task with the flaw stripped:

```
group           tasks  ok  extra-model-calls  extra-tokens  extra-cost  extra-ms
wrong-type         4   4                1.3           218     $0.0010       964
missing-field      3   3                1.0           139     $0.0007       844
extra-field        2   2                1.0           146     $0.0008       895
unknown-tool       2   2                1.0           151     $0.0008       723
stubborn           3   0                1.0           153     $0.0007       836
slow-corrector     1   0                1.0           172     $0.0009       991
```

a one-round correction costs one extra model call and roughly 140 to 220 extra
tokens, because the retry pays for the flawed emission, the error message, and a
re-read of the whole longer history. the twin runs on the same seed as the
flawed run, so the calls they share draw identical latency jitter and cancel -
the extra-ms is the marginal cost of the flaw, not a difference of two
independent runs.

the stubborn tasks are where the policies really separate:

```
feedback policy burns 21 model calls / 3969 tokens ($0.0172) before giving up
guarded  policy burns 9 model calls / 759 tokens ($0.0045) - loop guard aborts at the 3rd identical invalid call
saved: 3210 tokens (80.9%) on those tasks
```

80.9% of the stubborn-task spend is the feedback loop re-sending a growing
history to a model that was never going to change its answer. input tokens
compound: every futile round replays every earlier round.

## the drift extension: what should the guard key on

the original guard keys on exact (name, canonical args) identity, and the open
question was whether a model that mutates its broken call between rounds walks
right past it. it does, completely. this extension adds drifting flawed models
(each intent can carry a `flawDrift` sequence: a different malformed call per
feedback round) and a second guard key: the zod issue signature, the sorted
(path, code) pairs of the validation failure plus the tool name, with values,
messages, and the names of unrecognized keys deliberately left out. two calls
broken in the same way count together even when the broken values differ.

10 new drift tasks, all authored: 3 stubborn value drifters (a calc op that
cycles plus/sum/total/..., a city that is a different number every round, a url
that is never a url), 1 stubborn extra-key drifter (invents a new bogus field
name every round), 2 stubborn shape drifters (alternate or rotate between
different broken shapes), 2 same-signature slow correctors (drift values for 3
rounds, then emit the right call), and 2 progressive correctors (fix one issue
per round, so the signature shrinks). the guard limit stays 3 unless swept.

```
policy       ok     model  wasted  tokens-in  tokens-out  cost     failures
feedback     4/10     60      52       9321        1430  $0.0494  feedback-exhausted=6
guarded      4/10     60      52       9321        1430  $0.0494  feedback-exhausted=6
guarded-sig  2/10     38      34       3801         903  $0.0249  loop-detected=8
```

the exact guard is byte-identical to no guard on this suite: same completions,
same tokens, it never fires once. every stubborn drifter burns the full 7
emissions and dies in the feedback cap instead:

```
feedback     42 model calls    8375 tokens  $0.0375  saved 0.0%
guarded      42 model calls    8375 tokens  $0.0375  saved 0.0%
guarded-sig  24 model calls    3218 tokens  $0.0167  saved 61.6%
```

against fixed stubborn calls the exact guard saved 80.9%. against drifting ones
it saves 0.0%, so the saving was never about the guard being clever, it was
about the failure being dumb. the signature guard gets 61.6% back. but it is
not free: it kills both slow correctors (`slow-sig-corrector-calc`,
`slow-sig-corrector-city`), tasks the feedback policy completes, because a model
three rounds from correct and a model that will never correct emit identical
signatures for the first three rounds. completion drops 4/10 to 2/10 on this
deliberately adversarial suite. the shape drifters show the key's edge:
alternating two broken shapes gets caught at the 5th emission instead of the
3rd, rotating three walks past the guard entirely and dies in the feedback cap
at 7, the same price as no guard.

the interesting knob turns out to be the limit, not the key:

```
limit  ok     correctors-killed  stubborn-model-calls  stubborn-tokens  total-tokens
    2   2/10                  2                    15             1247          2434
    3   2/10                  2                    24             3218          4704
    4   4/10                  0                    30             4676          7052
    5   4/10                  0                    34             5691          8067
    6   4/10                  0                    38             6924          9300
```

at limit 4 the signature guard spares every corrector in the suite (the slow
correctors emit 3 same-signature calls, never 4) and still caps the stubborn
drifters at 30 model calls against feedback's 42, 44.2% of the stubborn tokens
saved with zero completion loss. the sweep says the guard key decides what you
can see and the limit decides how long you wait, and on this suite waiting one
extra round buys back every false positive.

the check that had to pass before any of this counts: on the original 25 tasks,
same seeds, the signature guard completes the same 21/25 as the exact guard and
no task diverges in outcome, model calls, or tokens. on verbatim-repeat
failures the two keys count the same things, so the signature key is a strict
widening, upgrade-safe by measurement.

same simulation disclosure as everything above: the drift patterns are authored,
so these numbers measure what each guard key can and cannot see, not how often
real models drift. a real stubborn model probably drifts messier than my six
authored variants, which would only widen the exact guard's blind spot.

## tradeoffs and where it breaks

- the feedback cap and the guard threshold are both blunt. 6 rounds is generous
  for a model that corrects in 1 and pure waste for one that never will; 3
  identical emissions kills a legitimately slow corrector. adaptive policies
  need real correction-rate data, which a scripted model cannot provide
- the guard key is a visibility choice, measured above: exact identity only
  sees verbatim repeats, the issue signature sees same-way-broken drift but
  confuses a slow corrector with a stubborn model until the limit expires, and
  a failure that rotates enough distinct shapes walks past both. no key
  computed from the current call alone can see "this conversation is not
  converging"
- token accounting replays the full history every call with no caching. thats
  faithful to a naive client but overstates the cost of long loops against any
  provider with prompt caching
- validation strictness is doing real work: zod strict objects reject the extra
  field a lenient schema would silently drop. lenient parsing would have turned
  the extra-field tasks into silent successes with possibly wrong semantics,
  which no metric here would catch

typescript because this is the applied side of the stack where agent runtimes
actually ship: the interesting parts are zod schema design, discriminated
unions over message types, and async loop control, and the strict compiler
holds the message-passing honest end to end.

## fixes

- 2026-08-28 — each flawed task is priced against its own clean twin, but the
  twin ran on its own seed, so the two runs drew independent latency jitter
  and the difference carried both runs noise instead of cancelling -
  unknown-tool printed 584ms for one extra model call, under the 600ms a
  model call costs at minimum. the twin reuses the flawed runs seed now. only
  extra-ms moved: wrong-type 983 → 964, missing-field 800 → 844, extra-field
  1269 → 895, unknown-tool 584 → 723, stubborn 785 → 836, slow-corrector
  662 → 991

## open questions

- real models dont fail on schedule. what are the actual per-flaw rates and
  correction curves for a production model on these same tool schemas, and does
  the 1-round recovery assumption survive contact
- the limit-4 verdict is only as strong as the authored correction curves: the
  slow correctors correct after exactly 3 rounds, so limit 4 spares them by
  construction. with correction times drawn from a distribution the sweep
  becomes a survival analysis, and the right limit is a quantile of it, which
  needs real correction-rate data
- the rotate-3 drifter beats both guard keys. a wasted-budget guard (abort
  after k invalid emissions per intent regardless of key) would catch it, but
  that is just a tighter feedback cap wearing a different name; whether any
  per-call key short of a convergence measure separates rotation from progress
  is open
- the signature ignores invented key names by design, so a model hallucinating
  a different bogus field each round is caught. the same collapsing would
  misfire on a tool whose schema legitimately varies by a discriminated union
  branch: two different union arms can share paths and codes. none of the
  tools here have that shape, so it is unmeasured
- prompt caching would collapse the replayed-history cost that dominates the
  stubborn burn. with cached input priced at a tenth of fresh input, how much
  of the 80.9% saving survives
- error message quality is untested: the scripted model corrects on any
  feedback, but a real model corrects better on some phrasings. an ablation
  needs a real model in the loop
- tool results here are always well-formed. the dual failure mode, valid args
  but garbage results the model then reasons over, is unmeasured and probably
  costs more
