# 08 agent tool loop

an agent loop with zod-validated tool calling and a hard retry/failure policy, run
over 25 scripted tasks to price what malformed tool args actually cost in model
calls, tokens, dollars and latency.

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
wrong-type         4   4                1.3           218     $0.0010       983
missing-field      3   3                1.0           139     $0.0007       800
extra-field        2   2                1.0           146     $0.0008      1269
unknown-tool       2   2                1.0           151     $0.0008       584
stubborn           3   0                1.0           153     $0.0007       785
slow-corrector     1   0                1.0           172     $0.0009       662
```

a one-round correction costs one extra model call and roughly 140 to 220 extra
tokens, because the retry pays for the flawed emission, the error message, and a
re-read of the whole longer history. the extra-ms column is noisier than the
rest; per-call latency carries seeded jitter, so treat those as rough.

the stubborn tasks are where the policies really separate:

```
feedback policy burns 21 model calls / 3969 tokens ($0.0172) before giving up
guarded  policy burns 9 model calls / 759 tokens ($0.0045) - loop guard aborts at the 3rd identical invalid call
saved: 3210 tokens (80.9%) on those tasks
```

80.9% of the stubborn-task spend is the feedback loop re-sending a growing
history to a model that was never going to change its answer. input tokens
compound: every futile round replays every earlier round.

## tradeoffs and where it breaks

- the feedback cap and the guard threshold are both blunt. 6 rounds is generous
  for a model that corrects in 1 and pure waste for one that never will; 3
  identical emissions kills a legitimately slow corrector. adaptive policies
  need real correction-rate data, which a scripted model cannot provide
- the guard keys on exact (name, canonical args) identity. a stubborn model that
  varies its broken call even slightly walks right past it and lands in the
  feedback cap instead, so the guard is a fast path for the dumbest failure
  mode, not a safety net for all of them
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

## open questions

- real models dont fail on schedule. what are the actual per-flaw rates and
  correction curves for a production model on these same tool schemas, and does
  the 1-round recovery assumption survive contact
- the guard fires on the 3rd identical invalid call; a model that mutates its
  broken call defeats it. would keying on the zod issue signature (paths and
  codes, not values) catch drifting-but-equivalent failures without new false
  positives
- prompt caching would collapse the replayed-history cost that dominates the
  stubborn burn. with cached input priced at a tenth of fresh input, how much
  of the 80.9% saving survives
- error message quality is untested: the scripted model corrects on any
  feedback, but a real model corrects better on some phrasings. an ablation
  needs a real model in the loop
- tool results here are always well-formed. the dual failure mode, valid args
  but garbage results the model then reasons over, is unmeasured and probably
  costs more
