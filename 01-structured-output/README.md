# 01 — structured output: schema validation + malformed-output retry

getting an llm to return json is easy — getting json you can actually feed to
downstream code every single time is the real job. this project builds that
layer from scratch: layered parsing for the garbage models actually emit, pydantic
validation against a strict schema, and a retry loop that feeds the concrete
error back to the model instead of just rolling the dice again.

## the concept

when you ask a model for json, the failure modes are boringly predictable —
markdown fences around the json, chatty prose before and after it, trailing
commas, python-style single quotes, truncated output, and then the sneakier
class where the json parses fine but violates your schema: invalid enum values,
missing fields, extra fields the model invented, wrong types

the fix has two distinct halves and it matters that theyre distinct

- **parse repairs are free** — stripping a fence or extracting the json out of
  prose costs zero extra llm calls. you should never pay for a retry on a
  failure a string operation can fix
- **schema violations need a retry, and the retry needs feedback** — the model
  returned `"priority": "URGENT"` when the schema wants lowercase, so tell it
  exactly that. a blind retry re-rolls the same dice — a feedback retry
  converges

the pipeline here does the cheap thing first, escalates only when it has to,
and after `max_retries` returns a typed failure instead of raising or handing
back half-validated junk — downstream code sees either a valid
`TicketExtraction` or a clean failure, nothing in between

## how it runs offline

theres no api key and no network. `extractor/llm_sim.py` is a deterministic
scripted llm — each ticket in `data/tickets.jsonl` carries a `plan` of failure
modes the fake model exhibits per attempt, and the corruption functions
reproduce real model failure shapes. the thing being mocked is the network, not
the logic — parsing, validation and retry are the real code under test. swap
`ScriptedLLM` for anything with a `complete(prompt) -> str` method and the
pipeline runs against a real model unchanged

## run it

```
cd 01-structured-output
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m pytest
.venv/bin/python run.py
```

## the numbers

30 tickets, every failure mode represented, fully deterministic:

| strategy | success | llm calls |
|---|---|---|
| strict json.loads, no retry | 20.0% | 30 |
| layered parsing, no retry | 60.0% | 30 |
| layered parsing + feedback retry (max 2) | 96.7% | 44 |

what they mean — naive `json.loads` glue code survives only perfectly clean
output. free string-level repairs triple that without a single extra call.
the feedback retry loop gets you to 29/30 at the cost of 44 calls for 30
tickets — a 47% call overhead, which is the real price of reliability and
exactly the number youd bring to a cost conversation. the one permanent
failure is a ticket whose model truncates output on every attempt, which is
the hard-failure policy doing its job: report it, dont hide it

`run.py` also prints which layer or retry rescued each failure mode, so you
can see e.g. that trailing commas never cost a retry but enum violations
always do

## tradeoffs and where it breaks

- the repair layers are ordered cheapest-first, but every layer you add is
  another way to silently accept output the model shouldnt have produced —
  `extra="forbid"` in the schema is the counterweight, drift fails loudly
- the balanced-brace extractor grabs the first `{...}` in the text — prose
  containing stray braces before the real json defeats it (theres a test
  pinning that exact limitation)
- feedback retries assume the model can act on the error message. the scripted
  model always complies eventually except one ticket — real models are worse at
  this, so real success rates land lower and you should measure yours
- retry-on-failure multiplies tail latency by up to `1 + max_retries` — fine
  for batch extraction, painful in a request path. thats where youd reach for
  constrained decoding or a providers native structured-output mode instead,
  and this pipeline becomes the fallback for when those arent available
- the scripted failure distribution is hand-built, not sampled from a real
  model — the rates are illustrative of the mechanism, not a benchmark of any
  actual model

## fixes

- 2026-08-25 — the brace walker only tracked double quotes, so a python-dict
  reply with an unmatched `{` or `}` inside a value got cut short and thrown
  away — a retry burned on output the `python_literal` layer already handles.
  both quote styles delimit strings now. no measured numbers moved, no summary
  in the dataset carries a brace
