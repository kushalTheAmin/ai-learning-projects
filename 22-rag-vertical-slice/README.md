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
npm test          # 69 tests: unit + integration over a live server
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

retrieval climbs the way you want, 0.650 to 0.950. answer accuracy does not follow it up, because extraction accuracy, the share of retrieved-gold queries the reader actually answers right, sits at 0.500 and slightly falls as k grows: every extra doc is another set of distractor sentences for the best-overlap pick to lose to. so k=1 to k=3 buys 0.100 answer accuracy for 2.85x the input tokens, and past that youre paying for context the reader wastes. the misses are attributed, not averaged away: at k=3 the 22 wrong queries are 10 wrong-sentence picks, 8 refusals with the gold doc sitting in context, and 4 retrieval misses, all of which refused rather than quoting an unrelated doc. answered-without-gold is 0 in every row, so the overlap floor never let the reader confidently quote the wrong doc.

the category split says where the damage is: keyword queries 0.700, paraphrase queries 0.200 at k=3. the same lexical machinery sits on both sides of this pipeline, so a paraphrased question pays twice, once in retrieval and once in sentence scoring. thats the measured version of why rag stacks want an embedder, a wall this repo has now hit from 03, 12, 13, 15, 18, 20, and here.

streaming: the first token completes at a mean 23.3% of the response bytes at k=3, computed from the wire encoding itself, so its exact and deterministic. a buffering client waits for 100% on all 40.

backpressure against a deliberately slow client (every write blocks one macrotask): on the worst case, the model dumping a whole 466-piece doc, an unbounded queue buffers 465 events / 17668 bytes at peak, the bounded(8) queue holds 8 events / 322 bytes with 457 stalled pushes, meaning generation itself was paced by the client 457 times. same shape 05 measured, now sitting where it belongs, between a server's generator and its socket. with a fast local client the queue never buffers at all (high-water 0 across all 162 logged requests): backpressure machinery is invisible until the client is slow, which is exactly the property you want.

validation is a table of exact rejections: empty or non-string question 400, k outside 1..10 400, question over 500 chars 413, body over 16 KB 413, non-json body 400, GET /ask 405, unknown path 404, unicode question streams fine. every rejection names what was wrong.

## tradeoffs and where it breaks

- the reader is the bottleneck by design, and honest about it: a lexical best-sentence pick cannot bridge paraphrase, so answer accuracy caps at roughly hit@k times 0.5 on this corpus. a real model would move extraction; this harness would price it.
- the refusal floor is one hand-set number. 0.35 trades 8 refusals-with-gold for 0 confident wrong-doc answers at k=3. lower it and refusals convert to wrong-sentence answers, not to correct ones.
- retrieval has no idf and no stemmer, docs are one vector each, and the corpus is 10 docs. at 10 docs a linear cosine scan is the right amount of machinery, at 10k docs youd want 13s hnsw under it, and the repo holds that part too.
- cost is linear in k because every request re-sends the full context. 11 measured what a prefix cache does to exactly this shape of bill, and the composition is unbuilt.
- the sse contract is asserted end to end (client-recomputed wire bytes must equal socket bytes, and they do), but the server never handles client disconnect mid-stream, and the queue caps events, not bytes; both are real production gaps left visible on purpose.

## why typescript

this is the applied-ai shape typescript actually ships: an http endpoint, streaming wire protocols, backpressure across async boundaries, token accounting on the request path. strict mode with typed event payloads catches the protocol drift these systems are famous for, and node's microtask/macrotask scheduling made the backpressure experiment deterministic without a mock clock.

## open questions

- a real model behind the same harness: does answer accuracy track hit@k up once extraction stops being lexical, and what does the paraphrase column cost in tokens to fix with a better reader vs a better retriever
- compose 11s prefix cache into the request path: system prompt and doc renderings are stable prefixes, so what does the k sweep's cost column look like with cache-billed tokens
- sweep the refusal floor and draw the operating curve (refusals-with-gold against answered-without-gold), 12s and 20s roc machinery applies as is
- the queue caps events; a byte-budgeted capacity (05s open thread, now with a server attached) is what a real memory ceiling wants
- put the endpoint under a request herd with 06s limiter and 09s pools composed in front, and measure whether per-request cost logging survives concurrency accounting-clean
