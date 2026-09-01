# 19-eval-regression

an eval harness with regression gating: run a model version over a golden
dataset, persist the run as an artifact, compare a candidate run against the
stored baseline, and decide ship or block. the interesting part is measuring
the deciders themselves. because every model version here is scripted with
known ground truth, each gate's false alarm rate and detection rate are
measurable facts, not vibes.

## what is simulated

the model is a script: each version is a per-category probability of
answering correctly, and a wrong answer emits the item's authored distractor.
rerun noise is modeled as independent per-item bernoulli draws under a fresh
seed. so every rate below measures the gating statistics against a known
truth, it says nothing about any real model's quality, and it understates
real-world noise where errors correlate across items and reruns. the golden
set itself is template-generated (six task categories, committed as
data/golden.jsonl, a test holds the file equal to the builder's output). the
paired bootstrap is imported from 02-retrieval-eval, not rewritten.

## the concept

an eval score is a sample, not a fact. on 240 items at ~0.88 accuracy, two
runs of the exact same model differ by up to 7 points here just from
resampling noise. any gate that reads the aggregate delta as a number
without an error bar is gating on noise, and any gate that only reads the
aggregate can be blinded by construction: improve five categories a little,
break one badly, and the mean never moves. the fixes are the two oldest
tools in statistics, an interval instead of a point (02's paired bootstrap
over per-item differences), and looking at the slices, not just the mean.
both have prices, and this project prices them.

## how to run

```
pip install -r requirements.txt
python3 main.py
python3 -m pytest
```

python 3.10+, stdlib only at runtime (pytest to test). main.py takes about
45 seconds: the sweeps run 50 comparisons per scenario and the power
curve evaluates golden sets up to 3840 items. it needs 02-retrieval-eval
checked out next to it for the bootstrap import.

## what the numbers say

headline comparison, baseline-1.0 vs masked-2.0, one run each. masked-2.0
drops the date category 24 points and gains 4.8 on the other five, so the
category-mean change is zero by construction:

```
aggregate accuracy: 0.8792 -> 0.8375 (delta -0.0417, 95% ci [-0.1042, +0.0208])
flips over 240 items: 177 both correct, 5 both wrong, 24 fixed, 34 broken
date  n=40  0.9000 -> 0.6500  delta -0.2500  ci [-0.4250, -0.0750]  p=0.0052
gate ci     pass, gate slice FAIL (date), gate slice-bonf pass, gate slice-bh pass
```

that run is the whole story in miniature. the aggregate ci straddles zero
so the aggregate gate passes, and it is right to: the aggregate really
didnt move, the -0.0417 is mostly noise. the regression is real anyway,
sitting in one slice the aggregate was built to average away, and the flip
table shows the churn (24 items fixed, 34 broken) a flat mean never
surfaces. and note the corrected gates: this exact catch, the one the
slice gate exists for, lands at p=0.0052 on the date slice, just above
the bonferroni cut of 0.025/6 = 0.0042. both corrected gates pass a real
24-point regression on this seed pair. correction is not free.

gate error rates over 50 seed pairs per scenario, each cell with its 95%
wilson interval — a rate over 50 comparisons is a sampled number like any
other, and this project would be a hypocrite quoting it bare:

| scenario (truth) | naive-0.01 | naive-0.02 | ci | slice | slice-bonf | slice-bh |
|---|---|---|---|---|---|---|
| noise only (no change) | 40.0% [27.6%, 53.8%] | 28.0% [17.5%, 41.7%] | 2.0% [0.4%, 10.5%] | 16.0% [8.3%, 28.5%] | 4.0% [1.1%, 13.5%] | 4.0% [1.1%, 13.5%] |
| masked slice regression | 40.0% [27.6%, 53.8%] | 32.0% [20.8%, 45.8%] | 4.0% [1.1%, 13.5%] | 68.0% [54.2%, 79.2%] | 50.0% [36.6%, 63.4%] | 50.0% [36.6%, 63.4%] |
| 3-point uniform drift | 72.0% [58.3%, 82.5%] | 58.0% [44.2%, 70.6%] | 6.0% [2.1%, 16.2%] | 24.0% [14.3%, 37.4%] | 14.0% [7.0%, 26.2%] | 14.0% [7.0%, 26.2%] |
| true 4-point improvement | 2.0% [0.4%, 10.5%] | 2.0% [0.4%, 10.5%] | 0.0% [0.0%, 7.1%] | 6.0% [2.1%, 16.2%] | 0.0% [0.0%, 7.1%] | 0.0% [0.0%, 7.1%] |

the intervals are wide, and that is the first thing to read off the
table — 50 pairs pins a rate to about ±13 points in the middle of the
range. every comparison below that survives its intervals is a real
gap, and the ones that dont are called out as such.

reading it down:

- the naive gates are unusable at this eval size. a 1-point tolerance
  false-alarms on 40.0% [27.6%, 53.8%] of no-change reruns; to a team on
  that gate, "the eval is red" carries almost no information, which is how
  eval gates die culturally. and it buys nothing: on the masked regression
  the naive gate fails at the same 40.0%, its own false alarm rate, because
  the aggregate it watches genuinely didnt move.
- the ci gate holds false alarms at 2.0% [0.4%, 10.5%] and pays for it
  with blindness — 4.0% [1.1%, 13.5%] on the masked regression, 6.0%
  [2.1%, 16.2%] on a real 3-point drift. dont read that 6.0% as the
  gate's detection rate: it is 3 hits out of 50 and its interval runs to
  16%, which is the same span the power curve's n=240 point lands in
  (23.3% [11.8%, 40.9%], 7 of 30) from a different golden set. the two
  cells are one quantity measured twice and neither pins it. what
  survives both is the shape — an honest error bar on 240 items cannot
  reliably see a 3-point change, and getting a sharper number than
  "somewhere around one in ten" needs hundreds of pairs, not fifty.
- the slice gate is the only one that catches the masked regression
  (68.0% [54.2%, 79.2%]), and its price is printed right above: 16.0%
  [8.3%, 28.5%] false alarms on noise, because six 95% intervals per
  comparison get six chances to be unlucky. multiple comparisons is not a
  footnote, it is a sixth of your green runs turning red.
- everything passes the improvement, and the ci confirms the improvement
  (interval fully above zero) in only 28.0% [17.5%, 41.7%] of pairs. even
  good news is hard to prove at n=240.

## what correction costs

the slice-bonf and slice-bh columns answer the question the first version
of this project left open: what does fixing the slice gate's false alarm
rate cost its detection? both corrections work on per-slice bootstrap
p-values, the fraction of resamples where a slice's delta lands at or
above zero (p_ge_zero, added to 02's paired bootstrap next to the
p_le_zero it already had). the plain slice gate's 95% interval test is a
one-sided test at alpha 0.025, so the corrected gates spend the same
0.025 budget and only the correction differs: bonferroni cuts each slice
at 0.025/6, benjamini-hochberg steps up through the sorted p-values
letting rank k spend k times that.

the trade, on this exact setup: false alarms drop 16.0% to 4.0%, and
masked detection drops 68.0% to 50.0%. eighteen points of real detection
is the price of twelve points of false alarms. whether thats a good trade
depends on what a red run costs your team; the point of measuring it is
that its now a number and not a footnote.

that trade is the one comparison here the intervals cannot carry —
68.0% [54.2%, 79.2%] against 50.0% [36.6%, 63.4%] overlap heavily, and
read as two independent proportions the difference would be nothing. it
holds because the gates are nested: a slice clearing the bonferroni cut
clears the uncorrected level too, so the corrected gate only ever fires
where the plain one did. the entry point prints the paired count instead,
and that is what the claim rests on — on the masked scenario slice-bonf
spares 9 of the 34 pairs slice flagged and adds 0, and the same 9-and-0
for slice-bh. nine flips all one direction out of fifty is a sign test at
p = 2^-9, so the cost is real even though the marginals dont show it. the
noise column is the same shape, 6 of 8 spared and 0 added, and the drift
column 5 of 12 and 0. this is the paired-vs-unpaired lesson from the
bootstrap itself, one level up: pairing is what makes a small difference
visible, and here the thing being paired is the gate verdicts.

two things the table says that i didnt expect when writing it down:

- bonferroni and benjamini-hochberg are identical in every cell here. bh
  is supposed to buy power back, but its rank-1 threshold IS the
  bonferroni cut, and it only pulls ahead when several slices regress at
  once so the higher ranks can fire. the masked scenario regresses
  exactly one slice, drift regresses six but each too weakly for any
  p-value to get small. one strong signal or six weak ones, neither is
  the shape bh exists for.
- the drift scenario is where correction hurts most in relative terms
  (24.0% detection falling to 14.0%, 5 of 12 pairs spared and 0 added,
  nearly half the signal gone). a diffuse regression puts every slice
  near the threshold, and correction moves the threshold away from
  exactly there. the aggregate ci gate is the right tool for that shape
  and it sees roughly one drift in ten at this size — 6.0% [2.1%, 16.2%]
  in the table, 23.3% [11.8%, 40.9%] in the power curve below, one
  quantity that fifty pairs cannot pin tighter than its own order of
  magnitude. the honest reading is that a 3-point drift on 240 items is
  near-invisible to every gate, corrected or not, and the power curve is
  the fix.

the combined production gate moves the same way: ci+slice fails 16.0%
[8.3%, 28.5%] of clean runs where ci+slice-bh fails 6.0% [2.1%, 16.2%]
(the extra 2 points over slice-bh alone are the aggregate ci gate's own
false alarms), and both catch the masked regression at their slice gate's
rate (68.0% vs 50.0%).

one honesty note on the p-values: p_ge_zero is a bootstrap direction
fraction pressed into service as a p-value, not an exact test, and at 500
resamples its resolution is 0.002, so the bonferroni cut of 0.0042
effectively tests at 0.004. the measured false alarm rates are the check
that this approximation behaves: 4.0% [1.1%, 13.5%] observed against a
nominal family-wise 2.5%, an interval that covers the nominal rate — the
check it can pass at 50 pairs, and not a tighter one.

power curve for the ci gate on the 3-point drift, growing the golden set
with the same templates:

```
n=240   detection 23.3% (7/30, 95% ci [11.8%, 40.9%])
n=960   detection 46.7% (14/30, 95% ci [30.2%, 63.9%])
n=3840  detection 93.3% (28/30, 95% ci [78.7%, 98.2%])
```

30 pairs per size, so these are wider than the table above — the n=240
point overlaps the 6.0% cell it duplicates, and n=960 overlaps both its
neighbours. what does not overlap is the two ends: [11.8%, 40.9%] at 240
against [78.7%, 98.2%] at 3840, and that gap is the whole lesson.
reliably seeing a 3-point regression takes thousands of items, not
hundreds. a 240-item eval is an alarm for catastrophes, not a caliper for
drift.

## the harness part

runs persist as json artifacts carrying a sha256 fingerprint of the exact
dataset, and loading recomputes the aggregates from the stored per-item
outcomes, rejecting a record that disagrees with itself. comparing runs
with different fingerprints raises instead of producing a number, because a
paired comparison across different item sets is quietly meaningless, and
quiet meaninglessness is the failure mode eval infrastructure exists to
prevent.

## tradeoffs and where it breaks

- gates here judge one candidate run. averaging k reruns shrinks the noise
  by sqrt(k) at k times the eval cost; that frontier (reruns vs more items)
  is unmeasured here.
- independent bernoulli noise is the friendliest possible noise. real rerun
  variance correlates across items and across runs, which widens the true
  interval; the bootstrap only knows about per-item pairing.
- the ci gate answers "did it regress at all". shipping usually wants "did
  it regress more than we tolerate", a non-inferiority margin on the
  interval's lower bound. at n=240 that gate would be even blinder.
- the corrected gates hold the family-wise rate by spending less alpha per
  slice, which is the only lever a fixed eval has. the real fix for the
  masked regression is more items in the slice that matters: correction
  trades within a budget, sample size raises it.
- the correction is measured at exactly six slices. more slices make the
  uncorrected gate worse and the bonferroni cut smaller in lockstep;
  nothing here says where a 40-slice eval (per-language, per-locale) lands.

## fixes

- 2026-09-01 — every gate rate was a bare point estimate off 50 pairs,
  which is the exact error this project argues against, and it showed:
  the ci gate's drift detection read 6.0% in the table and 23.3% in the
  power curve, one quantity twice, and the text called the gap a seed
  difference. now every rate prints its 95% wilson interval and the
  nested slice-vs-corrected comparison prints its paired count. no
  measured rate moved.

## why python

the statistics are the load-bearing part and 02's paired bootstrap already
exists in python with pinned semantics; the rotation rule allowed either
language and importing beats porting. everything else is stdlib.

## open questions

- bonferroni and bh tied on every scenario here because no scenario
  regresses two or three slices strongly at once, the shape bh's step-up
  exists for; authoring that scenario would finally separate the two
  corrections
- the corrected slice gate catches the masked regression 50% of the time
  at 40 items per slice; the power curve exists for the aggregate ci gate
  but the per-slice version (detection vs items in the regressed slice,
  under correction) is the one a team sizing a category eval actually needs
- where is the cost-optimal mix of reruns vs items for a target power?
- the flip table (24 fixed, 34 broken under a flat aggregate) is computed
  but never gated on; a churn gate might catch behavior swaps the mean
  hides, at an unknown false alarm price.
- correlated rerun noise: outcomes drawn from a shared per-run skill wobble
  would test whether the bootstrap interval still covers.
- a margin gate (fail iff ci hi < -margin) reshapes every rate above; the
  margin sweep is the natural next table.
