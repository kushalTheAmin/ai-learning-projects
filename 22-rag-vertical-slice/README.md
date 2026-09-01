# 22-rag-vertical-slice

the whole rag path as one running service instead of parts in isolation. POST /ask takes a question, retrieves the top k docs from a 10-doc ops corpus, a model picks the answer, and the answer streams back as server-sent events token by token with a bounded queue between generation and the socket. every request is logged with tokens in, tokens out, and dollars. an eval hook then runs the 40 golden queries against the live endpoint over real http, the same wire path a user takes, and grades what came off the wire.

five earlier projects supply the parts: the doc corpus and golden queries are 10s committed dataset, retrieval runs on 18s hashed word-feature vectors and sparse cosine, the queue and the client-side sse parser are 05s, sentence splitting and stopwords are 14s, token and cost accounting is 08s estimator. this project is the composition and the endpoint around them.

## what is simulated

the model. there is no llm here: the "model" is a scripted extractive reader that splits the retrieved docs into sentences, scores each by the fraction of the questions content words it contains, and streams the best sentence verbatim, or a fixed refusal when nothing clears a 0.35 overlap floor. deterministic by construction. the corpus and queries are authored. so the accuracy numbers measure what a lexical retrieve-and-extract pipeline does on this authored corpus, not what a real model would score, and the refusal behavior is a property of a hand-set threshold, not learned calibration. cost is 08s ~4 chars/token estimate priced at $3/$15 per million tokens, an accounting model, not a bill. the streaming, backpressure, and validation numbers are real properties of the running code.

## the concept

a vertical slice is the argument that composition is where production behavior lives. retrieval quality, context cost, streaming latency, memory under a slow client, input validation: each was measured somewhere in this repo on its own, but a service exhibits them all at once, and the interesting numbers are the ones that only exist at the seams. what does one more retrieved doc cost in tokens against what it buys in accuracy. how much of a response must a client hold before it can render anything. how far does generation run ahead of a slow reader. the slice makes each of those one measured row instead of a belief.

## how to run

```
npm ci
npm test          # 84 tests: unit + integration over a live server
npm run typecheck
npm start
```

node 20+. no network beyond localhost, no api key, everything offline.

## what the numbers mean

one traced request first. the question "what time does the nightly base backup run" retrieves pg-backups at cosine 0.2886, streams 11 token events, and the log entry prices it: 2367 tokens in (38 system + 11 question + 2318 context), 16 out, $0.007341. context is 2318 of the 2367 input tokens at k=3, which is the whole cost story of rag in one line.

the k sweep over the 40 golden queries, each row a full eval against the live endpoint:

```
 k  hit@k  answer   extr  wrong refused answerd refused   ctx tok    in tok    cost/req  cost/40
             acc      acc   sent  w/gold  no gold no gold
 1   0.650   0.350   0.538      9       3       0      14     843.5     896.3   $0.003071   $0.1228
 2   0.800   0.400   0.500     10       6       0       8    1672.5    1725.3   $0.005585   $0.2234
 3   0.900   0.450   0.500     10       8       0       4    2501.5    2554.3   $0.008098   $0.3239
 5   0.950   0.475   0.500     10       9       0       2    4176.4    4229.2   $0.013138   $0.5255
```

retrieval climbs the way you want, 0.650 to 0.950. answer accuracy does not follow it up, because extraction accuracy, the share of retrieved-gold queries the reader actually answers right, sits at 0.500 and slightly falls as k grows: every extra doc is another set of distractor sentences for the best-overlap pick to lose to. so k=1 to k=3 buys 0.100 answer accuracy for 2.85x the input tokens, and past that youre paying for context the reader wastes. the misses are attributed, not averaged away: at k=3 the 22 wrong queries are 10 wrong-sentence picks, 8 refusals with the gold doc sitting in context, and 4 retrieval misses, all of which refused rather than quoting an unrelated doc. answered-without-gold is 0 in every row, so the overlap floor never let the reader confidently quote the wrong doc; the floor sweep below shows exactly why.

the category split says where the damage is: keyword queries 0.700, paraphrase queries 0.200 at k=3. the same lexical machinery sits on both sides of this pipeline, so a paraphrased question pays twice, once in retrieval and once in sentence scoring. thats the measured version of why rag stacks want an embedder, a wall this repo has now hit from 03, 12, 13, 15, 18, 20, and here.

the refusal floor, swept. the reader refuses when the best sentence holds less than a 0.35 fraction of the questions content words, and this extension prices every other choice of that number. the overlap score turns out to be a decent confidence signal: over the 40 queries at k=3, correct answers score 0.400 to 0.875 (mean 0.594) while wrong ones score 0.143 to 0.600 (mean 0.350), roc-auc 0.903 (20s mann-whitney form, imported as is). the sweep runs the live endpoint at ten floors, one server per floor, and because the best sentence never depends on the floor, only whether it is served does, a single floor-0 run predicts every row; each live row is checked against that projection and matches exactly.

```
floor  answrd refusd  answer     acc|  wrong  answrd refused
                         acc  answrd    ans  nogold correct
 0.00     40     0   0.450   0.450     22      4      0
 0.15     39     1   0.450   0.462     21      4      0
 0.25     35     5   0.450   0.514     17      2      0
 0.35     28    12   0.450   0.643     10      0      0
 0.45     17    23   0.325   0.765      4      0      5
 0.50     17    23   0.325   0.765      4      0      5
 0.55     14    26   0.300   0.857      2      0      6
 0.65      8    32   0.200   1.000      0      0     10
 0.75      3    37   0.075   1.000      0      0     15
 1.00      0    40   0.000   1.000      0      0     18
```

the table says three things. first, the floor is a precision knob, not an accuracy knob: answer accuracy never rises as the floor climbs, because refusing can only convert wrong answers into refusals, never into correct answers. 0.450 is the ceiling, and floors past 0.400 pay for their precision with correct answers eaten (refused-correct hits 5 by 0.45 and all 18 at 1.00). second, the shipped 0.35 sits in a free window this corpus happens to leave open: the highest score any wrong-doc best sentence reaches is 0.333 and the lowest correct answer scores 0.400, so every floor in between blocks all four confident wrong-doc quotes and eats zero correct answers. that is why answered-without-gold reads 0 across the whole k sweep above. third, wrong-sentence answers are the residue the floor is bad at: 10 of them still clear 0.35, because a wrong sentence from the right doc shares the questions words nearly as well as the gold one; 0.65 finally silences them at precision 1.000, but coverage is 8 of 40 and accuracy 0.200.

youdens j over the observed scores picks 0.429 (keeps 0.778 of the correct answers and 0.182 of the wrong ones), but j weighs dropping a wrong answer the same as keeping a correct one, and whether that is the right exchange rate depends on what a wrong answer costs downstream, which is exactly what this pipeline cannot know. the sweep prices the options; it does not pick one.

streaming: the first token completes at a mean 22.6% of the response bytes at k=3, computed from the wire encoding itself, so its exact and deterministic. a buffering client waits for 100% on all 40. (this number was 23.3% before the floor extension: the done event now carries the refusal score, so every response is a few bytes longer and the first tokens share of them smaller.)

backpressure against a deliberately slow client (every write blocks one macrotask): on the worst case, the model dumping a whole 466-piece doc, an unbounded queue buffers 465 events / 17668 bytes at peak, the bounded(8) queue holds 8 events / 322 bytes with 457 stalled pushes, meaning generation itself was paced by the client 457 times. same shape 05 measured, now sitting where it belongs, between a server's generator and its socket. with a fast local client the queue never buffers at all (high-water 0 across all 162 logged requests): backpressure machinery is invisible until the client is slow, which is exactly the property you want.

validation is a table of exact rejections: empty or non-string question 400, k outside 1..10 400, question over 500 chars 413, body over 16 KB 413, non-json body 400, GET /ask 405, unknown path 404, unicode question streams fine. every rejection names what was wrong.

## tradeoffs and where it breaks

- the reader is the bottleneck by design, and honest about it: a lexical best-sentence pick cannot bridge paraphrase, so answer accuracy caps at roughly hit@k times 0.5 on this corpus. a real model would move extraction; this harness would price it.
- the refusal floor is one hand-set number, and the sweep shows the hand got lucky: 0.35 lands inside the (0.333, 0.400] window where it costs nothing and blocks every wrong-doc quote. that window is a property of these 40 queries, not of the mechanism; one paraphrased query with a 0.30 correct answer closes it, and then every floor is a real trade.
- retrieval has no idf and no stemmer, docs are one vector each, and the corpus is 10 docs. at 10 docs a linear cosine scan is the right amount of machinery, at 10k docs youd want 13s hnsw under it, and the repo holds that part too.
- cost is linear in k because every request re-sends the full context. 11 measured what a prefix cache does to exactly this shape of bill, and the composition is unbuilt.
- the sse contract is asserted end to end (client-recomputed wire bytes must equal socket bytes, and they do), but the server never handles client disconnect mid-stream, and the queue caps events, not bytes; both are real production gaps left visible on purpose.

## why typescript

this is the applied-ai shape typescript actually ships: an http endpoint, streaming wire protocols, backpressure across async boundaries, token accounting on the request path. strict mode with typed event payloads catches the protocol drift these systems are famous for, and node's microtask/macrotask scheduling made the backpressure experiment deterministic without a mock clock.

## open questions

- a real model behind the same harness: does answer accuracy track hit@k up once extraction stops being lexical, and what does the paraphrase column cost in tokens to fix with a better reader vs a better retriever
- compose 11s prefix cache into the request path: system prompt and doc renderings are stable prefixes, so what does the k sweep's cost column look like with cache-billed tokens
- the queue caps events; a byte-budgeted capacity (05s open thread, now with a server attached) is what a real memory ceiling wants
- the floor is global while the score distribution is per category (keyword correct answers score high, paraphrase ones hug the floor), so a per-category floor or a score normalized by question length might reopen the free window on harder traffic; needs a corpus where the current window is closed
- the overlap score prices its own retrieval: a low best-sentence score at k=3 could trigger retry-at-higher-k instead of refusal, spending tokens only on the queries that need them. the k sweep and the score are both already in hand, the policy is unbuilt
- put the endpoint under a request herd with 06s limiter and 09s pools composed in front, and measure whether per-request cost logging survives concurrency accounting-clean
