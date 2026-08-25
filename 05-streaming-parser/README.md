# 05 — streaming: SSE parsing, partial JSON, backpressure

Everything an LLM client does between "first byte arrives" and "message is
complete", built from scratch in TypeScript: an incremental SSE parser that
survives arbitrary chunk boundaries, a best-effort parser for the JSON prefix
of a streaming tool call, and a bounded channel that keeps a fast producer
from pinning unbounded memory. **The LLM is simulated**: a scripted response
is rendered to real SSE bytes and sliced into network-like chunks by a seeded
RNG — no model, no network, no API key. That makes the correctness numbers
real (the parsers genuinely survive every chunking) but the earliness and
backpressure numbers are properties of this scripted workload, not of any
provider's traffic: real streams pace chunks by generation speed, and real
tool calls have their own field orders and sizes.

## Why this exists

Streaming responses arrive as bytes that respect no boundaries you care
about: chunks split UTF-8 code points, SSE events, and JSON tokens without
apology. Every streaming client quietly solves three problems — reframing
bytes into events, showing tool arguments before their JSON closes, and not
buffering the world when the consumer is slower than the network. Solving
them by hand, with the failure cases measured, is the point of this project.

## Run it

```bash
npm ci
npm test        # 93 tests
npm start       # runs the four experiments below
npm run typecheck
```

Node 20+. No runtime dependencies; `devDependencies` are TypeScript, tsx,
and vitest only.

## What's inside

- `src/sse.ts` — incremental SSE parser. Accepts raw `Uint8Array` chunks,
  emits complete events, holds partial lines/events/code points between
  pushes (`TextDecoder` in streaming mode). Handles `data:` accumulation,
  `event:` names, comments, CRLF, and discards an unterminated trailing
  event per the SSE spec.
- `src/partial-json.ts` — best-effort parser for a JSON *prefix*. Returns
  the largest value the prefix already commits to, with an explicit
  truncation policy (table below). Corruption throws; truncation never does.
- `src/assemble.ts` — message assembler over Anthropic-shaped stream events
  (`content_block_start` / `content_block_delta` / `content_block_stop`),
  exposing a live snapshot: accumulated text plus tool args parsed from the
  JSON received so far.
- `src/backpressure.ts` — `BoundedQueue`, an async channel: `push()` parks
  the producer when full, `pop()` parks the consumer when empty, direct
  handoff when a consumer is already waiting. Records its own high-watermark
  and blocked-push count.
- `src/stream.ts` — the scripted response, SSE byte rendering, and the
  seeded chunkers (fixed-size and random, both free to cut mid-code-point).

### Truncation policy

The partial parser's contract, decided per truncation point:

| input ends…                    | result                          |
|--------------------------------|---------------------------------|
| inside a string                | keep the characters so far      |
| in an escape (`\` or `\u00`)   | drop the escape, keep the rest  |
| after a key (`{"a":`)          | drop the pair → `{}`            |
| inside a number (`12.`, `1e-`) | trim the dangling operator      |
| inside `true`/`false`/`null`   | drop it — commits to nothing    |
| inside `{...}` / `[...]`       | close with members parsed so far|

A bare number that reaches end of input is *usable but never complete* —
`"12"` may still become `"123"`. And prefixes are repaired, corruption is
not: `{"a": "b` parses, `{a: 1}` throws. `01` at end of input also throws —
no continuation can ever make it valid JSON, so treating it as a truncated
`0` would silently drop a byte.

## Numbers (from `npm start`, this machine, Node 22)

**1. Chunking robustness.** 54 chunkings of the same 8,939-byte stream —
fixed 1/7/64-byte, whole-stream, and 50 seeded random slicings, all free to
split multi-byte characters — reassemble the byte-identical message: same
text, same tool args. 4,914 intermediate snapshots, zero parse errors.

**2. Field earliness.** For a 251-byte tool call (12 leaf fields), the
partial parser makes the mean field readable *in its final form* at *48.2%*
of the argument stream; a wait-for-complete client reads everything at 100%.
First fields (`origin`, `destination`) are live before 15% of the JSON has
arrived. The catch: a partial string is indistinguishable from a final one —
`origin` reads `"Z"` then `"ZR"` then `"ZRH"` — so anything acting on a
field (as opposed to rendering it) still has to wait for the value to close.
This is a property of field *order*: JSON streams in document order, so
whatever the schema puts last (here, `note`) gets no earliness at all.

**3. What incremental readability costs.** This implementation re-parses the
whole accumulated prefix on every delta — O(n²) over the stream:

| arg bytes | events | re-parse total | single parse | overhead |
|-----------|--------|----------------|--------------|----------|
| 670       | 143    | 3.7 ms         | 0.03 ms      | ~120x    |
| 6,610     | 1,452  | 142.6 ms       | 0.17 ms      | ~800x    |
| 66,910    | 14,955 | 13,607.8 ms    | 1.70 ms      | ~8,000x  |

Free at typical tool-call sizes, prohibitive at 100x. The fix would be a
resumable tokenizer that carries its state between deltas — measured here as
the price of not having one, left unbuilt deliberately.

**4. Backpressure.** 5,040 chunks pushed by an instant producer against a
consumer that yields per chunk (synthetic pacing — real networks meter the
producer side too):

| policy         | peak buffered | blocked pushes | wall ms |
|----------------|---------------|----------------|---------|
| unbounded      | 5,039 items (~314 KB) | 0      | 23      |
| bounded cap=64 | 64 (~4 KB)    | 4,975          | 9       |
| bounded cap=8  | 8 (~0.5 KB)   | 5,031          | 7       |
| bounded cap=1  | 1 (~0.06 KB)  | 5,038          | 9       |

Throughput is consumer-bound under every policy — bounding the channel gives
up none of it; it only caps how much memory a producer burst can pin. At one
message the difference is 314 KB of transient buffer; the number that matters
is that it scales with burst size when unbounded and with the constant you
chose when bounded.

## What went wrong

- The first truncation policy trimmed trailing characters off any
  non-parsing number, which quietly turned `01` into `0` — dropping a real
  byte of input. The fix separates "a longer stream could finish this"
  (`12.`, trim and keep) from "nothing can rescue this" (`01`, throw), which
  needed a number-*prefix* grammar distinct from the number grammar.
- Deciding completeness for bare numbers is genuinely undecidable at end of
  input; the API had to make `complete` mean "no continuation could change
  this value" rather than "parsed successfully", and one test had to change
  once that was written down.
- The unbounded queue is the *slowest* policy in the table (23 ms vs 9 ms),
  which was not the expected result — buffering 5,000 items costs array
  growth and `shift()` traffic that the bounded channel never pays. The
  memory column was supposed to be the whole story; the wall-clock column
  arguing the same direction was a surprise worth keeping.
