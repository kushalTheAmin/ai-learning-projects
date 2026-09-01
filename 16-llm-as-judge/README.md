# 16 llm-as-judge

everything model-shaped here is simulated. the judges are scripted scoring
functions with authored biases of known size, the answers are generated text
whose quality is a latent number the generator assigned, and no model is ever
called. that inversion is the point: because every bias is planted with a known
magnitude, the numbers below measure whether the eval harness can detect and
correct a bias whose true size is on record. they say nothing about how biased
any real model actually is. what transfers is the harness, the protocols, and
the shape of each failure signature, not the specific rates.

## what this is

using an llm to grade another llm's output is now the default eval strategy,
and it fails in ways that look exactly like success. this project builds the
measurement side properly: a judge harness with pointwise pass/fail grading and
pairwise a/b comparison, three presentation-order protocols, chance-corrected
agreement, and per-protocol token and cost accounting. then it runs six
scripted judges through it, five of them with one authored defect each, and
checks which measurement catches which defect.

the judges: `calibrated` (quality plus small noise, the ceiling), `lenient`
(same but a rock-bottom pass threshold), `primacy` (favors whichever answer is
presented first by 0.15), `verbose` (rewards answer length at 0.2 per log unit
around a 120 token pivot), `self-pref` (adds 0.15 when the answer carries its
own "house" provenance tag), and `coin` (pure noise, the floor). every verdict
is deterministic given judge, item, and presentation order, so the whole run
replays byte for byte.

## run it

```
npm ci
npm run typecheck
npm test
npm start
npm run start:direction
```

node 20+. no network, no api key, no model download.

## the numbers

pointwise grading, 200 answers, gold pass rate 0.700:

```
judge       pass rate  accuracy  kappa
calibrated  0.690      0.990     0.976
lenient     0.955      0.745     0.198
coin        0.480      0.540     0.094
always-pass 1.000      0.700     0.000
```

the lenient judge passes 0.955 of everything and still scores 0.745 accuracy,
because with a 0.700 base rate, agreeing with the majority label is nearly
free. a judge that passes literally everything scores 0.700 without reading a
single answer. cohen's kappa subtracts exactly that payout: always-pass drops
to 0.000, lenient to 0.198, while calibrated holds 0.976. accuracy on an
imbalanced eval set is mostly the base rate wearing a costume, kappa is the
same comparison with the costume off.

pairwise on 150 balanced pairs, order swapped and re-asked (both-order):

```
judge       as-stored  randomized  flip rate  coverage  decided  effective
calibrated  1.000      0.993       0.007      0.993     1.000    0.997
primacy     0.847      0.887       0.287      0.713     1.000    0.857
coin        0.520      0.527       0.507      0.493     0.514    0.507
```

the flip rate is the diagnostic: ask the same pair in both orders and count
disagreements with itself. calibrated flips 0.007 of pairs, primacy 0.287, coin
0.507. and on the pairs where primacy agrees with itself, it is perfect (1.000
decided accuracy at 0.713 coverage), so the flips localize the damage to
exactly the small-gap pairs the position bonus can overpower.

the arrangement trap, 100 champion-vs-challenger pairs where the incumbent is
always presented first and the challenger truly wins half:

```
judge       champion-first  randomized  both-order
calibrated  0.500           0.500       0.495
primacy     0.380           0.440       0.485
```

presenting the incumbent first is the natural way to build a comparison eval,
and under a primacy judge it silently drags the challengers measured win rate
from a true 0.500 down to 0.380. randomizing the order per pair takes back most
of that (0.440), asking both orders takes back the rest (0.485). calibrated
runs 0.500 / 0.500 / 0.495 across all three, so what moves is the arrangement
and not the protocol. if your new model "loses" an a/b eval where the old model
was always option one, this is the first thing to rule out.

self-preference, 100 house-vs-rival pairs, house truly wins half:

```
judge       randomized  both-order
calibrated  0.500       0.505
self-pref   0.600       0.620
```

the one everyone reaches for, order randomization, does nothing here: the
bias rides on the answer's identity, not its position, so it survives the swap
untouched (0.600 single order, 0.620 both-order). order tricks only remove
order biases. detecting self-preference took a dataset where provenance is
balanced against gold by construction, which is a property you have to build,
not a protocol you can bolt on.

verbosity, 100 short-vs-long pairs, the long answer truly wins half:

```
judge       longer wins  acc long-better  acc short-better
calibrated  0.500        1.000            1.000
verbose     0.800        1.000            0.400
```

the verbose judge looks flawless whenever the better answer happens to be
longer, and collapses to 0.400 when the better answer is short. a judge can
carry a large bias and still ace your eval if the eval's attributes happen to
correlate with quality. the split by alignment is what exposes it.

cost, per 1000 pairs at these answer sizes ($3/M in, $15/M out):

```
as-stored   1 call/pair   $1.26
randomized  1 call/pair   $1.26
both-order  2 calls/pair  $2.53
```

randomized order is free and takes back most of a position bias — core
accuracy 0.847 to 0.887, champion win rate 0.380 to 0.440 against a truth of
0.500. both-order costs exactly 2x, closes the rest of the champion gap
(0.485), and buys what randomizing cannot: per-item confidence and the
flip-rate diagnostic itself. it does not buy accuracy — primacy's effective
accuracy under both-order (0.857, counting abstentions as coin flips) is below
its randomized single-order accuracy of 0.887. pay 2x for the position-bias
diagnostic and the undecidable items, not for the average.

## the sharpest finding

each eval mode is blind to a different bias class. pointwise grading cannot
express position bias at all (primacy grades 0.990, identical to calibrated,
because there is no second answer to prefer), and pairwise comparison cannot
express leniency (lenient compares 1.000 randomized, indistinguishable from
calibrated, because a threshold cancels out of a comparison). a judge eval
that only runs one mode certifies a judge against half the failure taxonomy.
you need both modes, and the numbers here show each mode catching a defect the
other scored as perfect.

## tradeoffs and where it breaks

- scripted judges have exactly one defect each. real judges carry correlated
  biases, and their magnitudes drift with the prompt, so real flip rates mix
  position bias with plain noise; separating them needs the noise floor this
  harness gets for free from `calibrated`
- the latent-quality model makes gold labels perfectly clean. real preference
  labels come from humans who disagree with each other, so real kappa ceilings
  sit far below 0.976 and the gap between judge-vs-gold and human-vs-human
  agreement becomes the honest metric
- abstentions are settled at half credit, which is correct in expectation and
  wrong for any single decision. a production gate needs a policy: re-ask,
  escalate to a human, or count as a loss
- the both-order protocol assumes two calls are independent. with temperature
  0 and a cached prefix, a real judge's two looks are correlated, and the flip
  rate underestimates the bias
- costs scale linearly in pairs and answer length; the interesting regime,
  adaptive protocols that only pay the second call on low-margin items, is not
  built here

## the direction extension: reading which way the flips point

answers the first two open threads below with new code and no change to the
harness: the flip rate conflates position bias with noise, so this extension
reads the direction of each flip instead of just counting them, then sweeps
authored bonus against quality gap to map when an arrangement bias flips an
a/b verdict. same rules as everything above: the judges are scripted, the
position bonuses are authored constants, so the statistic is being graded
against a ground truth the harness holds. run it with `npm run start:direction`
(seed 7, printed tables are what is quoted here).

the statistic: over both-order calls, count how often the winner was the
answer presented first. a pair whose two calls agree puts its winner in the
first slot exactly once, so consistency contributes 0.5 by construction. only
flips move the number, and only by their net direction: a flip where both
calls picked their first-presented answer pushes up, both picking the second
pushes down, and noise produces the two shapes in equal measure. first-win
rate minus 0.5 is the position lean; symmetric noise cancels out of it.

```
judge       flip rate  toward-1st  toward-2nd  first-win  lean
calibrated  0.007      0.000       0.007       0.497      -0.003
lenient     0.007      0.000       0.007       0.497      -0.003
primacy     0.287      0.287       0.000       0.643      0.143
verbose     0.060      0.027       0.033       0.497      -0.003
self-pref   0.013      0.007       0.007       0.500      0.000
coin        0.507      0.253       0.253       0.500      0.000
```

ranked by flip rate, coin is the worst position offender on the board. ranked
by lean, coin reads 0.000 exactly: its 76 flips split 38 toward-first, 38
toward-second, pure noise canceling itself. primacy flips fewer pairs (0.287)
but every single one lands toward-first, lean +0.143. that is the separation
the thread asked for: flip rate measures self-disagreement from any cause,
lean isolates the directional part, and the two together read primacy as
"biased" and coin as "useless", two verdicts one number kept conflating.

validated against authored ground truth, lean tracks the planted bonus:

```
bonus   0.00    0.03    0.06    0.09    0.12    0.15    0.20    0.25    0.30
lean    0.000   0.013   0.007   0.040   0.070   0.117   0.187   0.253   0.310
```

monotone, zero at zero, and grows with the bonus. but the magnitude is not a
bonus estimate. the expectation this was coded under was that more noise
dilutes the signal; measured, 3x noise (sigma 0.12) reads the same bonus
larger, 0.117 to 0.167 at bonus 0.15, 0.070 to 0.120 at 0.12. the mechanism:
a clean pair whose gap exceeds the bonus never flips, so at the cast's small
noise the bonus only sways the small-gap pairs, and extra noise hands it
pairs it could not win alone. so lean is a detector with a sign, not a
magnitude estimator; inverting it needs the noise floor and the gap
distribution, and the noise floor is exactly what calibrated's flip rate was
already measuring.

the suppression map, challenger win rate under champion-first presentation,
truth 0.500, 200 pairs per cell, exact quality gap per column:

```
bonus   gap 0.05  gap 0.10  gap 0.15  gap 0.20  gap 0.30
0.00    0.485     0.485     0.500     0.500     0.500
0.05    0.265     0.420     0.470     0.500     0.500
0.10    0.070     0.275     0.425     0.485     0.500
0.15    0.015     0.090     0.270     0.455     0.500
0.20    0.000     0.010     0.100     0.285     0.475
```

the knee sits where gap equals bonus: at bonus 0.15 the gap-0.15 column reads
0.270, roughly half the truly-better challengers erased, and the noise
(sigma 0.04 per answer, 0.057 per comparison) sets how soft the knee is. read
it as a verdict-flip map: an incumbent-first eval under a 0.15-primacy judge
reports near zero for challengers whose edge rides on gaps at 0.05, and is
honest again by gap 0.30. the original champion set's 0.380 is this map
integrated over its own gap draw. the operational loop this buys: both-order
calls are already paid for whenever the flip diagnostic runs, so lean is a
free extra column, and a lean materially off zero says exactly which of your
champion-first numbers, the small-gap ones, are fiction.

## fixes

- 2026-08-31 — the champion set credited order randomization with 0.485, which
  is the both-order column — randomized order was never run on that set at all,
  so the cheap protocol was being sold on the 2x protocol's number. the harness
  now runs all three protocols there and randomized comes out at 0.440, so
  randomizing takes back most of the 0.380 suppression and swapping takes back
  the rest. the recommendation moved with it: both-order is no longer "same
  average, extra diagnostics", it is 4.5 points closer to truth on this set

## language

typescript. the harness is orchestration, accounting, and protocol logic, the
exact shape of the eval infrastructure that ships next to a production llm
app, and the strict type system pins verdict domains (`"a" | "b" | "abstain"`)
so a forgotten abstention case is a compile error, not a silent number. the
scoring math is arithmetic, nothing numpy would improve. imports 05's seeded
prng and 08's token estimator and pricing rather than rewriting them.

## open questions

- lean detects and signs a position bias but does not size it: the same 0.15
  bonus reads 0.117 or 0.167 depending on the noise floor. matching the
  measured (flip rate, lean) pair against a simulated grid, with calibrated
  pinning the noise floor, could bracket the bonus; unmeasured
- the suppression map has exact gaps per column; a real eval has a gap
  distribution, so its suppression should be the map integrated over the gap
  histogram. checking that integral against the champion set's measured 0.380
  would validate the map as a predictor, not just a description
- lean needs both orders. a randomized single-call eval still correlates
  winner with slot, a weaker signal at half the cost, and its statistical
  power against both-order lean at an equal call budget is unmeasured
- position bias here is constant per judge. real models show primacy on some
  prompt shapes and recency on others; a per-item-length or per-domain bias
  model would test whether the flip diagnostic still localizes the damage
- abstention-aware aggregation: at what abstention rate does re-asking a third
  tiebreak call beat half-credit, given the third call shares the judge's bias?
- 02's paired bootstrap machinery applies directly to the win rates here; the
  0.600 house inflation on 100 pairs wants a confidence interval before anyone
  acts on it
- the real-model version of all of this: same harness, same balanced sets,
  actual api judges, which is the one measurement this project deliberately
  does not claim
