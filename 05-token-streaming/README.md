# 05 — token streaming: SSE parsing, partial JSON, backpressure

Everything here runs offline against a scripted stream: the "LLM" is an
authored fixture serialized to SSE wire bytes, and the network is a seeded
chunker that slices those bytes at arbitrary boundaries with small delays.
The event shapes mirror how real providers stream a reply (text deltas, then
tool-call arguments as raw JSON fragments), but no model and no network are
involved. The numbers below therefore measure the client-side machinery —
parsing correctness under adversarial chunking, how early partial parsing
makes data usable, and what a bounded queue does to memory — not the latency
or failure behavior of any real API. The time-to-first-text figure in
particular is a property of the simulated 2ms inter-chunk delay, not a claim
about real-world TTFT. The hostile streams in measurement 7 are authored
attacks (an unterminated line, a giant frame, an event that accumulates
forever), so those numbers measure the parser's bounds against those shapes,
not how often real servers misbehave.

Streaming is where LLM clients actually break. The network hands you bytes,
not tokens: a chunk can end mid-UTF-8-character, between the CR and LF of a
CRLF, or halfway through a `data:` line. Tool-call arguments arrive as
fragments of one JSON document that doesn't parse until the last token. And
a producer that's faster than its consumer will buffer without limit unless
something pushes back. This project builds the three pieces that handle
that, from scratch, and measures each one.

## What's here

- **`src/sse.ts`** — incremental Server-Sent-Events parser over raw bytes.
  Follows the WHATWG processing model where it matters: LF/CRLF/bare-CR line
  endings (including a CR sitting exactly on a chunk boundary), multi-line
  `data:` joined with `\n`, comments, one-leading-space stripping, events
  dispatched only when the data buffer is non-empty, last-event-id
  persistence. Multi-byte UTF-8 split across chunks is handled by
  `TextDecoder`'s streaming mode. `SseLimits` caps the two things the parser
  retains between chunks, the incomplete line and the in-flight event's
  accumulated data, with two failure modes: `"error"` throws a typed
  `SseLimitError` and poisons the parser, `"skip"` drops the offending line
  or event, counts it in `stats`, and keeps parsing what follows.
- **`src/partialJson.ts`** — parses any prefix of a valid JSON document into
  the best-known value. One left-to-right scan tracks the container stack,
  the in-progress token, and the last index that closes cleanly; at end of
  input it finishes the current token when unambiguous (close the string,
  `tru` → `true`, trim `12.` to `12`), drops what it can't finish (a key
  with no value yet), and closes the open containers.
- **`src/resumableJson.ts`**: the same partial-JSON semantics without the
  rescan. `parsePartialJson` starts from character zero on every call, so a
  snapshot per fragment costs O(n²) over the stream. this parser carries its
  state between `push` calls instead: the container stack holds references
  into the value tree it is building, string tokens decode as their
  characters arrive, and the accumulated text is never kept at all. two read
  paths with different prices: `view()` returns the live tree in O(1) beyond
  finishing the dangling token, `snapshot()` returns a deep copy you can
  keep, at O(tree). `src/resumableBench.ts` generates seeded documents and
  replays them through both parsers to price the difference.
- **`src/queue.ts`** — bounded async queue with producer-side backpressure:
  `await push()` doesn't resolve while the buffer is full, so the producer
  runs at the consumer's pace. Records its own high-water mark and stall
  time. Capacity comes in two currencies: the positional form counts items,
  and the options form (`{ maxBytes, sizeOf }`) budgets bytes, admitting an
  item only while the buffered total stays inside the budget. One rule keeps
  the byte budget deadlock free: an item is always admitted into an empty
  buffer, even when it alone exceeds the budget, so the true bound is
  max(budget, largest single item) and `stats.oversizedPushes` counts how
  often that escape hatch fired.
- **`src/byteQueueStudy.ts`**: the measurement rig for measurement 6, a
  seeded heavy-tailed chunk-size workload (90% tiny 3..30 bytes, 9% medium
  200..2000, 1% huge 16384..32768), seeded shuffles, and a replay harness
  where the producer pushes steadily or in bursts and the consumer takes one
  chunk per macrotask tick, counting idle ticks, stalls, and byte
  high-water. Every reported number is a count or a byte total, so the runs
  reproduce exactly.
- **`src/sseLimitStudy.ts`**: the rig for measurement 7, authored hostile
  wires (a line with no terminator, a giant terminated frame, one event of
  thousands of data lines) and a replay harness that feeds a wire through a
  parser in fixed-size chunks and reports events delivered, drops, and the
  retained-state high-water. All ASCII, so chars and bytes coincide and
  every number reproduces exactly.
- **`src/pipeline.ts`** — chunks → SSE events → accumulated text and
  tool-call arguments, with a partial-parse snapshot after every fragment.

## Run it

```
npm ci
npm test        # 126 tests
npm start       # the seven measurements below
npm run typecheck
```

## Numbers (seed 20260826, 5185-byte stream in 420 chunks of 1–24 bytes)

**1. Streaming vs buffering.** First text is visible ~23ms into a ~930ms
stream — a streaming client shows something at ~2.5% of the wait a
buffer-the-whole-response client pays. Both figures are wall clock over the
simulated 2ms inter-chunk delay, so they move a few percent run to run. The
reassembled text and tool arguments are byte-identical to the fixture, so the
early output costs no correctness.

**2. Partial JSON on streamed tool arguments.** All 35 argument fragments
yield a usable snapshot (35/35). Two columns, both a fraction of total stream
bytes received: when the field first parses at all, and when its value first
carries anything — a non-empty string, a container with an entry in it, or
any scalar.

| field | first parsed | carries a value |
|---|---|---|
| `query` | 44.1% | 44.1% |
| `top_k` | 59.0% | 59.0% |
| `filters` | 60.5% | 63.8% |
| `include_snippets` | 86.6% | 86.6% |
| `note` | 88.6% | 88.6% |
| any field, waiting for complete JSON | 100.0% | 100.0% |

The two columns only separate for `filters`, and that separation is the point
of having them — an object parses as `{}` the moment its key gets a value
position, so "available at 60.5%" would mean a dispatcher reads the filters
and gets nothing. It has a filter in it at 63.8%. Scalars are whole the
instant they parse, so their columns coincide.

The gap against 100% is still the argument for partial parsing: a UI can
start rendering the query at 44.1% instead of waiting for the closing brace.
What it has there is `"bre"` — the first three characters of a query that
keeps growing — so it is something to show, not something to validate or
dispatch on.

**3. Backpressure.** Fast producer (whole stream already buffered), slow
consumer (1ms per chunk):

| queue | buffer high-water | producer stalled | wall time |
|---|---|---|---|
| unbounded | 419 chunks (5169 bytes) | ~0ms | ~490ms |
| bounded(8) | 8 chunks (149 bytes) | ~480ms | ~490ms |

The chunk and byte columns are exact and reproduce every run; the two
millisecond columns are wall clock on the machine that ran it and move a few
percent run to run.

Wall time is identical because the consumer is the bottleneck either way.
The bounded queue converts "buffer the entire backlog" into "make the
producer wait", holding memory flat at 149 bytes instead of 5169 — which is
the difference between O(1) and O(stream) memory. 5KB doesn't hurt anyone;
the same shape with a 2GB file transfer or ten thousand concurrent streams
does.

**4. Chunk-boundary fuzz.** 300/300 seeded random byte-level chunkings of
the same wire produce byte-identical event sequences, plus a byte-by-byte
degenerate case and a mixed CRLF/CR/LF wire fuzzed separately in the tests.

**5. Resumable scan vs full rescan.** The open question from the first
version of this project: partial snapshots recomputed from the accumulated
text are O(n²) over the stream, so at what size does that matter. Answer
from the sweep below: there is no crossover to wait for, the resumable
scanner wins at every size measured, and the gap grows quadratically. Same
workload both sides, one value materialized after every fragment, seeded
fragments of 1 to 24 chars, correctness cross-checked by asserting all modes
end on identical results. Equivalence first: 300/300 seeded chunkings of the
fixture arguments match the rescan baseline at every fragment boundary.

| doc chars | fragments | rescan+reparse | resumable view | speedup | snapshot per fragment |
|---|---|---|---|---|---|
| 266 | 23 | 0.09ms | 0.03ms | 3.4x | 0.08ms |
| 1071 | 88 | 0.90ms | 0.16ms | 5.5x | 0.57ms |
| 8273 | 662 | 41.13ms | 0.71ms | 57.7x | 12.59ms |
| 65619 | 5264 | 2457.96ms | 3.71ms | 662.5x | 669.45ms |

Wall times are medians (50/20/5/3 repeats by row) on the machine that ran
it and move a few percent run to run; the fragment and character counts are
exact and reproduce every run. The work counts say why the table looks like
this: at 65619 doc chars the baseline feeds 172521764 chars through its
scanner, 2629.1x the document, and then pays roughly the same again in
`JSON.parse` of the repaired text. The resumable scanner reads 65619 chars,
1.0x, no reparse. At 1048586 chars the resumable view finishes the whole
replay in 69.1ms over 84070 fragments, about 0.8µs per fragment; the
baseline projects to ~629.2s by the n² law (projected, not run, that is ten
minutes of CPU for one megabyte of streamed JSON).

The snapshot column is the honest asterisk: a deep copy per fragment is
O(tree) again, so it grows quadratically too, 3.7x cheaper than the
baseline at 64KB but the same shape. The win lives in `view()`, and `view()`
comes with a contract: the value is the parser's live tree, valid until the
next call, never to be mutated. Cheap reads or owned reads, pick per call.

**6. Byte-budgeted backpressure.** Measurement 3 capped the queue at 8
chunks and it worked because the fixture's chunks are all 1..24 bytes. This
one asks what happens when chunk sizes stop being polite. The workload is
2000 seeded chunks, 620116 bytes total, sizes 3..32706 bytes (median 19,
span 10902x): mostly single-token deltas, an occasional huge tool-argument
fragment. The tail owns the memory story, 16 chunks over 4096 bytes are
0.8% of the chunks and 63.0% of the bytes.

First, what a chunk count actually promises. Same workload, six arrival
orders, steady producer, consumer takes one chunk per tick:

| ordering | count cap 8, peak bytes | byte cap 65536, peak bytes |
|---|---|---|
| as generated | 49061 | 65536 |
| shuffle 1 | 59971 | 65536 |
| shuffle 2 | 54583 | 65536 |
| shuffle 3 | 35570 | 65536 |
| shuffle 4 | 35750 | 65536 |
| huge first | 221864 | 65536 |

The count cap's memory is ordering luck: the five seeded orders sit between
35570 and 59971 bytes, and the adversarial order (all huge chunks first)
holds 221864, 4.5x the friendliest seed, because eight slots filled with
32KB chunks cost what eight 32KB chunks cost. Its only real promise is
8 x 32706 = 261648 bytes. The byte cap holds exactly 65536 under every
ordering, including the hostile one; a budget in the unit memory is spent
in cannot be gamed by arrival order.

Second, what the promise costs. To promise 64KB with a chunk count on this
workload you must cap at 2 chunks (2 x 32706 = 65412). Bursty producer,
bursts of 50 chunks then 25 silent ticks, consumer takes one chunk per tick:

| queue | worst-case bytes | peak bytes | mean buffered bytes | consumer idle ticks | stalled pushes |
|---|---|---|---|---|---|
| unbounded | none | 293111 | 154359 | 0 | 0 |
| count cap 8 | 261648 | 49061 | 2407 | 624 | 1679 |
| count cap 2 | 65412 | 33623 | 616 | 858 | 1919 |
| byte cap 65536 | 65536 | 65536 | 46412 | 0 | 28 |

The two caps that promise the same 64KB behave nothing alike. Count cap 2
holds a mean of 616 buffered bytes, two typically-tiny chunks of run-ahead,
so every silent gap starves the consumer: 858 idle ticks on a 2000-chunk
stream, a 43% delivery-time tax. The byte cap buffers a mean of 46412
bytes, hundreds of tiny chunks deep when chunks are tiny and two chunks
deep when they are huge, rides out every gap with zero idle ticks, and
stalls the producer 28 times instead of 1919. That is the whole argument:
a count cap prices every chunk at one slot, so it must assume the worst
chunk everywhere; a byte cap prices each chunk at its size, so depth floats
exactly where depth is cheap. The unbounded row is the price of refusing to
choose, peak 293111 bytes, nearly half the stream buffered at once.

Two edges worth naming. A budget below the largest chunk cannot hold: byte
cap 4096 on this workload peaks at 32706 bytes, the largest chunk, with 16
oversized admissions, because an item bigger than the whole budget is
admitted alone into an empty buffer rather than deadlocking; the bound is
max(budget, largest item), and the stats say every time it was the item.
And the uniform control (1..24-byte chunks) shows why measurement 3 was
never wrong: count cap 8 peaks at 160 bytes of its 192-byte worst case;
near-uniform sizes are the one regime where a chunk count is an honest
memory bound. The full pipeline runs behind a 256-byte-capped queue and
parses the fixture byte-identically, so the budget costs no correctness.

**7. SSE limits.** The parser retains two things between chunks: the current
incomplete line, and the data accumulated for the in-flight event. A hostile
or broken server can grow either one forever, and the open question from the
byte-queue round was where the cap goes and what the right failure mode is
when it fires. The answer is `SseLimits`: `maxLineChars` and
`maxEventChars`, measured in UTF-16 code units of the decoded stream because
that is the unit the retained strings actually occupy memory in, and a
deliberate choice between failing closed and degrading.

The hazard first: an unterminated `data:` line of 4194304 chars fed in
1024-char chunks to an uncapped parser produces 0 events and a retained
high-water of 4194310 chars. The whole poison, held forever, waiting for a
terminator that never comes.

`onLimit: "error"` fails closed. `maxLineChars 65536` throws
`SseLimitError("line")` after 66560 of 4194310 chars, 1.6% of the poison,
retained high-water 66560 chars. The parser is poisoned after the throw and
every later call rethrows; this is the mode for a client that treats an
over-limit stream as a protocol violation and tears the connection down.

`onLimit: "skip"` drops the offending line or event and keeps the stream. On
a wire of 20 events, one complete event whose data line is 1048576 chars,
then 20 more events: no limits delivers 41 events at high-water 1048690
chars; skip mode delivers 40, drops 1 line, and holds high-water at 65650
chars against the bound of cap 65536 + chunk 1024. Every post-poison event
survives, so one oversized frame costs one frame, not the connection.

The line cap alone is not enough. 2100 short data lines belonging to one
event pass a 65536-char line cap individually, every line terminated, and
the event still accumulates 1077299 chars (uncapped high-water 1077521).
`maxEventChars 65536` in skip mode drops 1 event, delivers the 5 tail
events that follow it, high-water 65803 chars. Two caps because there are
two growth paths: the line cap bounds the buffer a missing terminator
grows, the event cap bounds the accumulation a missing blank line grows.

And the caps cost nothing when nothing is wrong: 300/300 seeded chunkings
of the well-formed fixture parse byte-identical to the uncapped reference.

## Design notes, and the honest parts

- **A partial value is a snapshot, not a promise.** `"12` may become `125`,
  so a trimmed number (`12.` shown as `12`) can differ from the number the
  stream was mid-way through writing. Strings only ever grow by appending —
  the tests pin that every partial string is a prefix of the final one —
  but numbers can be plain wrong until the delimiter arrives. A consumer
  that acts on numeric fields before the document closes is speculating.
- **The parser is lenient about garbage tails.** `{"a": trux` is not a
  prefix of any valid JSON, but the parser drops the invalid token and
  returns `{}` rather than rejecting. For the streaming use case that
  lenience is harmless; for validation it would not be.
- **Dropped keys reappear.** `{"key"` parses to `{}` — a key doesn't exist
  until its value has started. So the set of visible keys tells you nothing
  about what's coming; only the fixture's key order makes the availability
  table look inevitable.
- **A key existing is not the same as it holding anything.** The step after
  the one above: `{"filters": {` gives you `filters` as `{}`. The key is
  there, the value is empty, and a table that only records first-parse counts
  that as available. That is why measurement 2 carries a second column — and
  even it only proves the field is non-empty, not that it is finished.
- **The CR-on-chunk-boundary case is the one a naive splitter loses.** A
  `\r` as the last byte of a chunk can't be classified until the next chunk
  says whether a `\n` follows. The first fuzz corpus (LF-only fixture)
  couldn't catch that; it took a dedicated mixed-endings wire to put the CR
  paths under fuzz at all. Fuzzing only the bytes you happen to emit is a
  quiet way to test nothing.
- **The resumable parser is pinned to the baseline, not to a spec.** Its
  contract is "same answer as `parsePartialJson` for every prefix of a valid
  JSON document", and the tests hold that prefix by prefix, under seeded
  chunkings, and through split escape sequences and surrogate pairs. On
  invalid input it diverges twice, on purpose: it never throws (the baseline
  can let `JSON.parse` escape on a raw control character inside a completed
  string), and once a fragment poisons the document it answers unparseable
  forever without scanning another char.
- **`view()` moves the cost to a contract.** The O(1) read hands out the
  live tree, so a dangling token's completed value is spliced in and
  reverted on the next call; hold that reference across a `push` and you
  are reading a mutating object. `snapshot()` exists exactly so the caller
  can pay O(tree) to opt out. An API that hid this by always copying would
  quietly reinstate the quadratic bill the scanner just removed.
- **Backpressure didn't cost throughput here, but that's the setup
  talking.** With a consumer-bound pipeline, pacing the producer is free.
  With a bursty consumer, a capacity of 8 would add latency the unbounded
  queue absorbs — the right capacity is a claim about burst shape, and this
  demo doesn't measure that. Measurement 6 measures exactly that shape for
  the producer side: bursts against a too-shallow cap starve the consumer.
- **FIFO under a byte budget needs an explicit rule.** Under an item cap,
  "the buffer has room" and "a producer is waiting" cannot both be true, so
  admission never has to think about the waiting line. Under a byte budget
  they can: a tiny chunk fits while a huge one waits, and admitting the tiny
  one would reorder the stream. The queue's first byte-capped draft had
  exactly that bug; the FIFO test caught a later 5-byte push overtaking a
  pending 100-byte one, and admission now defers to the waiting line before
  it checks the budget.
- **Error mode drops events completed earlier in the same feed call.** The
  throw happens mid-drain, so events the chunk had already completed never
  reach the caller. That is fine for a mode whose contract is "tear it
  down", but it is a contract: a caller that wants every last event before
  the failure runs skip mode and reads `stats` instead.
- **The cap boundary has a one-char trap.** A line of exactly the cap
  ending in a CR on a chunk boundary sits in the buffer as cap + 1 chars,
  but the CR is an unclassified terminator, not part of the line; counting
  it would fail streams sitting exactly at the limit that happen to use
  CRLF. The tests pin that case in error mode, where the false positive
  would kill the connection. The mirror case matters too: an over-cap
  buffer ending in CR is a completed poisoned line, and entering
  discard-until-terminator there would silently eat the healthy line that
  follows.
- **The idle-tick currency belongs to the harness.** The consumer pays one
  tick per chunk whatever its size, so idle ticks price starvation in
  chunks, not bytes. A consumer whose cost scales with chunk size would
  shift the starvation numbers; the memory columns would not move, they are
  properties of admission alone.

## fixes

- 2026-08-27 — the field availability table counted a field as available the
  moment it first parsed, and `filters` first parses as `{}` — so 60.5% said
  you could read filters that werent there yet. table has a second column for
  when the value first carries anything. `filters` 60.5% → 63.8%, every other
  field unchanged (scalars and strings are non-empty as soon as they parse)
- 2026-08-27 — the backpressure demo reported buffered memory as chunk count
  times the *maximum* chunk size, so it claimed 10032 bytes buffered out of a
  5185-byte stream — nearly twice the whole thing. the queue sums the real
  byte lengths now. unbounded peak 10032 → 5169 bytes, bounded(8) 192 → 149

## Open questions

- The byte budget cannot bound below the largest item, but chunks are just
  bytes: the queue could slice an oversized chunk into budget-sized pieces
  instead of admitting it whole. That restores the strict bound at the cost
  of more queue operations per chunk and a consumer that must tolerate
  arbitrary re-chunking; where the slicing overhead crosses the memory win
  is unmeasured.
- `sizeOf` is trusted, and for byte chunks it is exact. For decoded objects
  (22 measures its wire events by serialized length) it is an estimate, and
  estimate error rescales the real memory bound by exactly the error; how
  wrong a practical estimator runs on real event mixes is unmeasured.
- The run-ahead a budget buys depends on burst shape: 65536 bytes held a
  mean of 46412 buffered under 50-chunk bursts and never starved, but a
  burst larger than the budget would starve the byte cap too. The
  burst-size-over-budget sweep that maps where that starts is unrun.
- The limits count decoded UTF-16 units, but the attack arrives as bytes:
  the whole hostile chunk is decoded before any cap looks at it. A byte
  cap ahead of the decoder would refuse work earlier, and could feed the
  fused byte-level scanner idea below; what decoding a poison stream
  itself costs is unmeasured.
- Skip mode counts drops, but the events around a dropped line still
  dispatch, so a consumer cannot tell which delivered event lost a line.
  Surfacing drops in-band (an error event carrying the drop position)
  changes the consumer contract; whether any client can use a
  damaged-but-flagged event is the design question.
- The caps here are hand-picked constants. A deployment would set them
  from an observed frame-size distribution the way the byte queue sets
  its budget, with a false-drop rate attached to the chosen quantile;
  that needs a corpus of real provider streams, the same gap as the
  replay-a-real-stream thread.
- The snapshot column grows quadratically because a deep copy touches the
  whole tree. A persistent-structure version (path copying, shared
  unchanged children) would make an owned snapshot O(depth) per fragment;
  what does that cost `push`, and where is the crossover against
  `structuredClone`?
- The resumable parser reads decoded strings, so 22's pipeline still pays
  a `TextDecoder` pass between the SSE layer and this one. A scanner over
  raw UTF-8 bytes would fuse those and could feed directly from the wire;
  whether the fused version beats decoder + scanner is unmeasured.
- `view()` per fragment is ~0.8µs, so the next bottleneck in a real client
  is probably the consumer reacting to every fragment. A dirty-flag layer
  (which paths changed since the last view) would let a UI re-render only
  what moved; the bookkeeping cost per push is the open number.
