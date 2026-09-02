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
npm test          # 125 tests: unit + integration over a live server
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

score-gated escalation. the floor sweep left one policy unbuilt: the overlap score is on the wire before anything streams, so a low score at k=3 could trigger a retry at a wider k instead of a refusal, spending the big context only on the queries the score flags. this extension builds it as a server option (`escalation: {trigger, k2}`, escalate iff the first pass scores under the trigger and k2 widens the request) and prices the whole policy plane. billing is two model calls, not one repriced call: with a real model the first draft has to exist before anything can score it, so an escalated query pays the first call in full, input and suppressed draft output, then the second call on the wider context. this server knows the score before streaming and could skip the draft; it bills as if it couldnt, to keep the cost model honest for the production shape.

before the table, the anatomy that decides everything: 12 of 40 queries score under 0.35 at k=3, and they split 4 retrieval misses against 8 queries whose gold doc is already in context. widening k is a superset operation on this retriever (top-5 starts with top-3, a test holds it), so the gold sentences score never moves for those 8; more retrieval can only ever convert the 4 misses. and of those 4, exactly 1 converts even at k=10, where the context holds the entire corpus: the other 3 are paraphrase-bound, the gold doc arrives and its sentence still loses or stays under the floor. the score can say an answer is weak; it cannot say why, and only one of the two whys is fixable with more retrieval.

```
policy               escal helped hurt atrisk  answrd  answer  mean in    cost/40  vs fixed
                                               nogold     acc      tok             k2 cost
fixed k=3                 0      -     -      -       0    0.450    2554.3    $0.3239         -
fixed k=5                 0      -     -      -       0    0.475    4229.2    $0.5255         -
  k2=5 trig 0.35         12      1     0      0       0    0.475    3838.6    $0.4808     91.5%
  k2=5 trig 0.45         23      1     0      5       0    0.475    4992.8    $0.6258    119.1%
  k2=5 trig 0.55         26      1     0      6       0    0.475    5307.0    $0.6650    126.5%
  k2=5 trig 0.75         37      1     0     15       0    0.475    6463.0    $0.8093    154.0%
  k2=5 always            40      1     0     18       0    0.475    6783.5    $0.8494    161.6%
  k2=5 oracle             1      1     0      0       0    0.475    2655.3    $0.3368     64.1%
fixed k=10                0      -     -      -       0    0.475    8339.8    $1.0191         -
  k2=10 trig 0.35        12      1     0      0       0    0.475    5056.3    $0.6272     61.5%
  k2=10 trig 0.45        23      1     0      5       0    0.475    7349.4    $0.9089     89.2%
  k2=10 trig 0.55        26      1     0      6       0    0.475    7975.0    $0.9855     96.7%
  k2=10 trig 0.75        37      1     0     15       0    0.475   10268.6    $1.2662    124.3%
  k2=10 always           40      1     0     18       0    0.475   10894.1    $1.3430    131.8%
  k2=10 oracle            1      1     0      0       0    0.475    2762.8    $0.3497     34.3%
```

the headline row is trigger 0.35 to k2=10: accuracy 0.475, exactly fixed k=10s, at 61.5% of its cost ($0.6272 vs $1.0191 per 40). that equality is not luck, its the free window again: any query a wider k can fix was a retrieval miss, every retrieval miss scores at most 0.333 at k=3, and 0.333 sits under the 0.35 trigger, so the trigger catches every fixable query by construction. the same argument caps what raising the trigger can buy at exactly nothing: every row above 0.35 escalates more queries (23 at 0.45, 40 at always) and converts the same 1, because the extra escalations are all queries whose gold doc is already in context. on this corpus the trigger belongs at the floor and not one point higher, and always-escalate is strictly worse than fixed k2 (131.8% of its cost) because it pays the k=3 draft on top of every wide call.

the hurt column is 0 everywhere, but only some of those zeros are evidence, which is what the atrisk column next to it is for. hurt needs an escalated query that was correct before it escalated, and the headline row cannot have one - the trigger sits on the floor, so escalation only ever fires on a query that already refused, and a refused query is not correct. same for the oracle rows, which escalate only the queries escalation fixes. atrisk counts what could have been hurt, and it reads 0 on both. the real evidence is the rows above the floor: 5 correct answers escalate at 0.45, 6 at 0.55, 15 at 0.75, 18 at always - every correct answer on the set - and not one of them flips. so a wider context outvoting a gold sentence is ruled out by those four rows, not by the row the headline is about.

answered-without-gold stays 0 too, with the same split. the k2=10 rows cannot read anything else: at k=10 the context is the whole 10-doc corpus, so no escalated query can be missing its gold doc. the k2=5 rows are where the column is measured - 2 queries still miss gold at k=5, and both refuse rather than quoting the wrong doc, the free window holding one k wider.

the oracle rows price what the trigger cannot see. an oracle that escalates only the 1 query escalation actually converts spends $0.3497 at k2=10 against the triggers $0.6272: the 11 pointless escalations, 8 unfixable-by-construction plus 3 where the gold doc arrives and still loses, are 44% of the policys bill. the score is a good refusal signal (roc-auc 0.903) and a weak routing signal, because routing needs to know why the score is low, and that distinction (gold missing vs gold present but paraphrase-bound) is exactly what a single scalar cannot carry.

every policy row is a projection over two floor-0 captures (per-query score, would-be correctness, gold hit, and token counts at k=3 and at each k2), same discipline as the floor sweep, and live escalation servers at two grid points reproduce their projected rows exactly, checked field by field including the dollar totals.

streaming: the first token completes at a mean 22.6% of the response bytes at k=3, computed from the wire encoding itself, so its exact and deterministic. a buffering client waits for 100% on all 40. (this number was 23.3% before the floor extension: the done event now carries the refusal score, so every response is a few bytes longer and the first tokens share of them smaller.)

backpressure against a deliberately slow client (every write blocks one macrotask), re-read now that the queue can budget bytes. the /ask queue used to cap events; 05s queue grew a maxBytes budget, and this extension wires it through as a server option (`queue: {maxBytes}`), logs the per-request byte high-water, and re-measures. the harness now streams the full wire shape of a request, meta then tokens then done, because the sizes are nothing alike: token events run 34-48 wire bytes while meta and done carry json payloads near 190. the earlier table streamed token events only, so its numbers were smaller.

```
longest golden answer: 53 events / 2304 wire bytes (meta 195 B, tokens 34-43 B, done 185 B)
  unbounded  high-water  52 events /  2109 bytes buffered,   0 stalled pushes, 0 oversized admissions
  events-8   high-water   8 events /   448 bytes buffered,  44 stalled pushes, 0 oversized admissions
  bytes-512  high-water  13 events /   496 bytes buffered,  39 stalled pushes, 0 oversized admissions
  bytes-128  high-water   3 events /   185 bytes buffered,  49 stalled pushes, 1 oversized admissions
worst case, model dumps the whole top doc: 468 events / 18078 wire bytes (meta 183 B, tokens 34-48 B, done 186 B)
  unbounded  high-water 467 events / 17895 bytes buffered,   0 stalled pushes, 0 oversized admissions
  events-8   high-water   8 events /   443 bytes buffered, 459 stalled pushes, 0 oversized admissions
  bytes-512  high-water  14 events /   512 bytes buffered, 448 stalled pushes, 0 oversized admissions
  bytes-128  high-water   3 events /   186 bytes buffered, 464 stalled pushes, 1 oversized admissions
```

the unbounded row is the memory bug: generation runs the whole response ahead of the client, 17895 bytes buffered on the dump. the shipped events-8 cap holds that to 8 events, but "8 events" is 272 bytes if they are the smallest tokens and 1560 if they are meta-sized payloads; the cap just doesnt know. here it reads 443-448 because the two big events never co-buffer on this stream, which is luck of the mix, the thing 05 measured swinging with item order under a heavy-tailed one. bytes-512 makes the promise in the right currency, peak 512 exactly on the dump, and buffers 13-14 events at roughly the memory the event cap spent on 8, so equal memory buys more run-ahead. bytes-128 shows the floor: the done event is 185-186 wire bytes, bigger than the whole budget, and the queue admits it alone rather than deadlocking (1 oversized admission, peak equal to the event, not the budget). a byte budgets real bound is max(budget, largest single event), the rule 05 established, holding with a server attached.

and the swap costs nothing observable: a live /ask server on `queue: {maxBytes: 1024}` reproduces the event-cap servers k=3 eval row exactly, checked field by field, with queue high-water 0 bytes and 0 oversized admissions across its 40 requests, because a fast local client drains every event before it can buffer (high-water 0 across all 202 logged requests on the main server too). backpressure machinery stays invisible until the client is slow, which is exactly the property you want, and the request log now carries the byte high-water per request, so a slow client would leave a number instead of an anecdote.

validation is a table of exact rejections: empty or non-string question 400, k outside 1..10 400, question over 500 chars 413, body over 16 KB 413, non-json body 400, GET /ask 405, unknown path 404, unicode question streams fine. every rejection names what was wrong.

## tradeoffs and where it breaks

- the reader is the bottleneck by design, and honest about it: a lexical best-sentence pick cannot bridge paraphrase, so answer accuracy caps at roughly hit@k times 0.5 on this corpus. a real model would move extraction; this harness would price it.
- the refusal floor is one hand-set number, and the sweep shows the hand got lucky: 0.35 lands inside the (0.333, 0.400] window where it costs nothing and blocks every wrong-doc quote. that window is a property of these 40 queries, not of the mechanism; one paraphrased query with a 0.30 correct answer closes it, and then every floor is a real trade.
- retrieval has no idf and no stemmer, docs are one vector each, and the corpus is 10 docs. at 10 docs a linear cosine scan is the right amount of machinery, at 10k docs youd want 13s hnsw under it, and the repo holds that part too.
- cost is linear in k because every request re-sends the full context. 11 measured what a prefix cache does to exactly this shape of bill, and the composition is unbuilt.
- the sse contract is asserted end to end (client-recomputed wire bytes must equal socket bytes, and they do), but the server never handles client disconnect mid-stream; a real production gap left visible on purpose.
- the queue now budgets bytes, but it measures an event by serializing it twice, once for admission and once for the write. at 468 events per response that cannot matter; at real throughput the wasted serialization is a cpu-for-memory trade nobody priced.

## why typescript

this is the applied-ai shape typescript actually ships: an http endpoint, streaming wire protocols, backpressure across async boundaries, token accounting on the request path. strict mode with typed event payloads catches the protocol drift these systems are famous for, and node's microtask/macrotask scheduling made the backpressure experiment deterministic without a mock clock.

## fixes

- 2026-09-02 — the escalation section sold "the hurt column is 0 everywhere, and thats measured, not assumed", but at trigger 0.35 the trigger sits on the refusal floor, so escalation only fires on queries that already refused and none of them was correct going in — hurt was 0 by construction on the headline row and on both oracle rows, and the same for answered-without-gold on the k2=10 rows, where the wider context is the whole corpus. the policy table now carries an `atrisk` column, the escalated queries that were correct before escalating, so a 0 with nothing behind it reads as vacuous: 0 at trigger 0.35 and on the oracles, 5 / 6 / 15 / 18 on the rows above the floor, which are the four that actually rule the risk out. no measured number moved — the column is new, every other cell is what it was.

## open questions

- a real model behind the same harness: does answer accuracy track hit@k up once extraction stops being lexical, and what does the paraphrase column cost in tokens to fix with a better reader vs a better retriever
- compose 11s prefix cache into the request path: system prompt and doc renderings are stable prefixes, so what does the k sweep's cost column look like with cache-billed tokens
- the queue buffers whole events while the wire is just bytes, so the byte budget floors at the largest single event; a byte-chunk queue between serializer and socket could pin any budget exactly with no oversized escape, and what losing event boundaries does to the first-token measurement and the logs event count is the design question
- with a fast local client every byte high-water in the log reads 0; replaying a captured real network pace (05s thread, same gap) would turn the per-request byte column into a live signal instead of a slow-sink experiment
- the floor is global while the score distribution is per category (keyword correct answers score high, paraphrase ones hug the floor), so a per-category floor or a score normalized by question length might reopen the free window on harder traffic; needs a corpus where the current window is closed
- the trigger sees that a score is low, never why: a second signal that separates gold-missing from paraphrase-bound (the retrieval score margin between the top docs is already computed and on the wire) could route only the fixable misses and close part of the 61.5%-vs-34.3% oracle gap
- escalation here widens k on the same retriever, so the 8 paraphrase-bound refusals are unreachable by construction; retrying with a different retriever instead (a stemmer, 03s fusion, 25s hyde rewrite) is the escalation that could reach them, and this harness prices it the same way
- hurt = 0 is this corpus being kind: the gold sentence wins every wider contest it was winning at k=3. a corpus where a distractor sentence outvotes a gold answer only once the context is wide enough would put a real number in the hurt column and make the trigger a two-sided risk
- put the endpoint under a request herd with 06s limiter and 09s pools composed in front, and measure whether per-request cost logging survives concurrency accounting-clean
