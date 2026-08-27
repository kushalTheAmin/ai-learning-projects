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
about real-world TTFT.

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
  `TextDecoder`'s streaming mode.
- **`src/partialJson.ts`** — parses any prefix of a valid JSON document into
  the best-known value. One left-to-right scan tracks the container stack,
  the in-progress token, and the last index that closes cleanly; at end of
  input it finishes the current token when unambiguous (close the string,
  `tru` → `true`, trim `12.` to `12`), drops what it can't finish (a key
  with no value yet), and closes the open containers.
- **`src/queue.ts`** — bounded async queue with producer-side backpressure:
  `await push()` doesn't resolve while the buffer is full, so the producer
  runs at the consumer's pace. Records its own high-water mark and stall
  time.
- **`src/pipeline.ts`** — chunks → SSE events → accumulated text and
  tool-call arguments, with a partial-parse snapshot after every fragment.

## Run it

```
npm ci
npm test        # 55 tests
npm start       # the four measurements below
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
yield a usable snapshot (35/35). Field availability, as a fraction of total
stream bytes received when the field first parsed:

| field | available at |
|---|---|
| `query` | 44.1% |
| `top_k` | 59.0% |
| `filters` | 60.5% |
| `include_snippets` | 86.6% |
| `note` | 88.6% |
| any field, waiting for complete JSON | 100.0% |

That gap is the whole argument for partial parsing: a UI can show the query
being searched, or a dispatcher can start validating it, at 44% of the
stream instead of 100%.

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
- **The CR-on-chunk-boundary case is the one a naive splitter loses.** A
  `\r` as the last byte of a chunk can't be classified until the next chunk
  says whether a `\n` follows. The first fuzz corpus (LF-only fixture)
  couldn't catch that; it took a dedicated mixed-endings wire to put the CR
  paths under fuzz at all. Fuzzing only the bytes you happen to emit is a
  quiet way to test nothing.
- **Backpressure didn't cost throughput here, but that's the setup
  talking.** With a consumer-bound pipeline, pacing the producer is free.
  With a bursty consumer, a capacity of 8 would add latency the unbounded
  queue absorbs — the right capacity is a claim about burst shape, and this
  demo doesn't measure that.

## fixes

- 2026-08-27 — the backpressure demo reported buffered memory as chunk count
  times the *maximum* chunk size, so it claimed 10032 bytes buffered out of a
  5185-byte stream — nearly twice the whole thing. the queue sums the real
  byte lengths now. unbounded peak 10032 → 5169 bytes, bounded(8) 192 → 149

## Open questions

- The queue's capacity is in chunks, not bytes — a byte-budgeted queue is
  what a real memory ceiling wants. What does the high-water story look
  like when chunk sizes vary by 1000x?
- Partial-JSON snapshots are recomputed from the full accumulated text on
  every fragment — O(n²) over the stream. A resumable scanner that carries
  its state between fragments is the fix; at what document size does the
  recompute actually matter?
- The SSE parser buffers one line, but a malicious or broken stream can
  send an unbounded line with no terminator. Where's the cap, and what's
  the right failure mode when it's hit?
