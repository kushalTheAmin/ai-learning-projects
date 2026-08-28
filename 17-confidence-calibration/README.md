# confidence calibration and temperature scaling

a classifier says 0.99 and it means "im right 88% of the time". this project measures that gap, fixes it with one fitted scalar, and prices what the unfixed gap does to the thing confidence scores are actually used for: deciding which predictions to trust automatically and which to escalate.

everything here is simulated or from scratch. the corpus is synthetic: support tickets assembled from authored phrase banks, where a controlled fraction of each ticket borrows phrases from a different intent, so the data has genuine ambiguity built in. the classifier is a from-scratch softmax regression on bag-of-words counts. so the headline numbers demonstrate the calibration machinery, the shape of miscalibration under overfitting, and what temperature scaling can and cannot fix. they say nothing about how calibrated any real model is; the same harness pointed at real logits would say that.

## the concept

calibration is a promise about frequencies. if a model says 0.9 on a thousand predictions, about nine hundred of them should be right. accuracy doesnt care about this at all, you can be 79% accurate while claiming 96% confidence everywhere, and argmax never notices. but every system that *acts* on a confidence score notices. route low confidence to a human, auto-apply high confidence, cache above a threshold; all of these read the probability as a probability. if it isnt one, the policy built on it does something different from what its author thinks it does.

the measurement is the reliability table: bin predictions by confidence, compare each bins mean confidence against its actual accuracy. expected calibration error (ece) is the count-weighted average of those gaps, mce the worst one. temperature scaling is the classic fix from guo et al 2017: divide every logit by one scalar T fitted on a validation set to minimize nll. T > 1 softens, T < 1 sharpens, and since scaling by a positive scalar never reorders a row, accuracy is provably untouched. the fit here is a golden-section search over inverse temperature, which is sound because cross-entropy is convex in the logits and logits times a scalar is linear in it, so the 1-d objective is convex; no gradients, no luck, same answer every run.

## run it

```
pip install -r requirements.txt
python main.py
pytest tests/ -q
```

no api keys, no downloads, runs in about a second. seeded and deterministic end to end: zero-init full-batch training, seeded data generation, convex temperature search. same output every run.

## what happens

600 training tickets, 4 intents, 277 vocabulary tokens, trained 3200 epochs with weak l2. the training curve is the guo et al story in miniature: validation accuracy is done moving early (0.818 at epoch 100, 0.772 at 3200) while validation ece climbs the whole time, 0.034 at epoch 100 to 0.159 at 3200. cross-entropy keeps paying the model to sharpen distributions long after it has stopped learning anything about the labels.

on held-out test the raw model reads: accuracy 0.795, nll 0.994, brier 0.333, ece 0.130, mce 0.303. the reliability table says where it lies. the [0.70,0.80) bin claims 0.753 and delivers 0.450. the big bin is worse in aggregate than it looks per item: 919 of 1200 predictions sit above 0.9 confidence, claiming 0.990 and delivering 0.886.

one temperature fitted on 400 validation tickets: T = 3.060. the logits were three times too sharp. after scaling, test accuracy is 0.795 exactly as before (the tests assert not one prediction moved), nll 0.994 to 0.592, brier 0.333 to 0.296, ece 0.130 to 0.030.

the policy table is the production translation. auto-answer iff confidence >= t, escalate the rest:

```
     t   raw cover  raw acc  cal cover  cal acc
  0.80       0.843    0.859      0.537    0.958
  0.90       0.766    0.886      0.379    0.980
  0.99       0.598    0.936      0.083    0.990
```

raw scores break the promise at every threshold: the "at least 90% confident" slice is 88.6% accurate, and even demanding 0.99 only buys 93.6%. with raw scores there is no threshold in this table that hits a 5% auto-answer error budget. calibrated scores keep the promise (conservatively, 0.980 at t=0.90) and the cost surfaces where it belongs, in coverage: you auto-answer 37.9% instead of 76.6%, because 37.9% is what this model can actually vouch for at that standard. the raw policy was answering the other 39% on confidence it didnt have.

then the part that keeps this honest: distribution shift. the shifted stream raises the ambiguity rate and swaps the filler phrases for vocabulary the model never saw. accuracy drops 0.795 to 0.539, and raw ece explodes to 0.342. the validation-fitted T still helps, 0.342 to 0.140, but its promise is broken too: the calibrated policy at t=0.90 answers 15.8% of shifted traffic at 0.831 accuracy, not the ~0.98 it delivers in-distribution. an oracle temperature fitted on the shifted stream itself gets ece to 0.024, but T moves from 3.060 to 5.691, so calibration is a property of the traffic, not of the model. a temperature fitted once and trusted forever is a number quietly going stale.

## tradeoffs and where it breaks

- temperature scaling is one global scalar. it fixes uniform over-sharpening beautifully and cannot fix anything shaped: a model overconfident only on one class, or only on long inputs, needs per-class temperatures or something richer. the post-scaling reliability table still shows small nonuniform residue here (bins wobble around zero gap instead of sitting on it)
- mce is a fragile headline. after scaling it reads 0.285, nearly unchanged from 0.303, and that number rides entirely on a 2-item bin where both predictions missed. ece weights bins by count; mce hands the headline to whichever near-empty bin is unluckiest. bin counts belong next to any calibration claim
- ece itself depends on the binning. 10 equal-width bins is the convention and its what this repo prints, but equal-count bins or a different bin count move the third decimal. the honest reading is the table, not the scalar
- the fix is only as good as the validation set. T fitted on 400 tickets recovered most of the calibration; T fitted on traffic that no longer matches production is the shift experiment, and it degrades silently, which is exactly how it fails in deployments
- accuracy among answered items is not the only policy metric. calibrated coverage at t=0.90 is half the raw coverage; whether thats a win depends on what an escalation costs versus a wrong auto-answer. this project prices the promise, not the business

python was the right language here. the whole project is matrix arithmetic, softmax algebra and a numeric search, which is numpy territory; the same code hand-rolled in typescript would be slower to write, slower to run, and would teach the same thing worse. the tokenizer is imported from 02-retrieval-eval so tokenization semantics stay identical across the repos python projects.

## open questions

- the model here is miscalibrated by overfitting, one specific mechanism. an llm asked to emit a confidence number, or judged by token logprobs, miscalibrates differently; running this exact harness over real api logprobs is the obvious next measurement
- one temperature per model is the coarsest knob. per-class temperature, platt scaling with a bias, or binning-based recalibration would show what the residual 0.030 ece is made of, and what each extra parameter buys
- the shift experiment shows T goes stale but not when. an online recalibration loop (refit T on a sliding window of labeled outcomes) has a lag/variance tradeoff that would compose directly with 06s rate limiting style of measurement
- ece on 1200 items has sampling noise this project never quantifies. 02s paired bootstrap machinery applies to the ece delta and to the policy table rows, and was not run
- the selective policy uses max softmax as the trust signal. margin (top1 minus top2) and entropy are the other cheap signals, and which one ranks mistakes best is measurable right here with no new data
