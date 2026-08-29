# field-level precision and recall for structured extraction

everything here is simulated: the extractors are scripted flaw injectors, not
models, and the 12 gold invoices are authored by hand. each extractor takes the
gold record and damages it in one known way (drops fields, invents fields,
reformats values, shuffles arrays, corrupts values) at a seeded, known rate. so
the numbers below measure how different metric designs score known damage, they
do not measure any real extraction model. thats the point though: you cant
audit a metric against a model whose true quality you dont know. you can audit
it against damage you authored.

## what it does

scores extraction output (predicted json) against gold json at the level of
individual leaf fields instead of whole records. every gold leaf ends up
correct, wrong, or missing; every predicted leaf ends up correct, wrong, or
spurious. precision is over predicted leaves, recall over gold leaves, so
hallucinated fields cost precision, dropped fields cost recall, and a wrong
value costs both. on top of that sit two design axes you have to pick and most
people pick silently:

- a value normalization ladder. L0 strict equality, L1 adds unicode nfkc plus
  casefold plus whitespace collapse, L2 adds numeric parsing ("$1,234.50"
  matches 1234.5, "42" matches 42, within a tolerance), L3 adds date parsing
  ("Jan 5, 2024" matches "2024-01-05"). slash dates are refused on purpose,
  05/01/2024 is a different day in london and in dayton, and a metric should
  not guess.
- an array alignment policy. index compares position by position; aligned
  scores every (gold element, predicted element) pair by its own field f1 and
  greedily matches best first, deterministic tie-break, so element order stops
  mattering but absent and invented elements still get charged.

per-field tables (array indices collapsed, so every line items qty aggregates
under `line_items[].qty`) plus macro f1 over gold paths come out of the same
pass.

## the concept

record-level exact match is the metric you get for free and it throws away
almost everything. an extraction that formats the date differently scores
identically to one that invents the numbers: both 0. field-level scoring turns
one bit per record into a per-field ledger, and then the two axes above decide
what counts as "the same value" and "the same item". those decisions are the
metric. same discipline as 02/12/19: build the ground truth so you know the
right answer, then check the metric recovers it.

## run it

```
npm ci
npm run typecheck
npm test
npm start
```

node 20+, no runtime deps, fully offline, everything seeded (seed 42).

## the numbers

12 invoices, 224 gold leaves. the headline table:

```
extractor       exact   strict P      R      F1   semantic P    R      F1   macroF1
perfect         1.000   1.000  1.000  1.000      1.000  1.000  1.000    1.000
format-drift    0.000   0.219  0.219  0.219      1.000  1.000  1.000    1.000
shuffler        0.417   0.647  0.647  0.647      1.000  1.000  1.000    1.000
tax-bungler     0.000   0.946  0.946  0.946      0.946  0.946  0.946    0.923
lazy            0.500   1.000  0.839  0.913      1.000  0.839  0.913    0.943
dropper         0.000   1.000  0.759  0.863      1.000  0.759  0.863    0.854
hallucinator    0.000   0.665  1.000  0.799      0.665  1.000  0.799    0.947
corruptor       0.000   0.728  0.728  0.728      0.728  0.728  0.728    0.740
```

exact match gives format-drift, tax-bungler, and corruptor the same score,
0.000, though one of them is a perfect extraction, one has a single wrong
field, and one is 27% garbage. strict field scoring already separates them
(0.219 / 0.946 / 0.728) but ranks format-drift as the worst extractor in the
roster, worse than the one that actively invents numbers. semantic scoring
(L3 plus alignment) restores the constructed truth: the three extractors that
preserve every fact score exactly 1.000 and the failure classes line up below
them, with precision naming the hallucinator (0.665 P, 1.000 R) and recall
naming the dropper (1.000 P, 0.759 R).

the ladder shows which forgiveness layer does the work:

```
extractor        L0 exact     L1 text  L2 numeric     L3 date
format-drift        0.219       0.397       0.946       1.000
corruptor           0.728       0.728       0.728       0.728
```

format-drift climbs a step per layer and hits exactly 1.000; corruptor never
moves, because its damage is semantic, not surface. that flat line is the
safety check: a normalization layer that ever moves the corruptor is a layer
that forgives real errors.

alignment is the same story for arrays. shuffler goes 0.647 by index to 1.000
aligned (delta +0.353) and every other extractor has delta 0.000, so order
insensitivity came free of collateral damage on this roster.

and the per-field table is the observability payoff. tax-bungler micro f1 is
0.946, a number nobody would page on, but the breakdown reads:

```
totals.tax                  0.000  0.000  0.000
```

every other row 1.000. micro says "fine", the ledger says "the tax field is
dead". macro f1 (0.923 vs micro 0.946) moves the right direction because it
weights that rare field equally.

one thing the code showed that i did not design in: macro over gold paths is
blind to hallucination. the hallucinator scores macro 0.947, above its own
micro 0.799, because `po_number` and `line_items[].sku` never exist in gold,
so they have no gold path to average over. they cost micro precision and they
show up as spurious rows, but a macro-only dashboard would rank the
hallucinator second best in the roster. averaging over the union of paths
sounds like the fix and isnt, recall is undefined on a path gold never has.

## tradeoffs and where it breaks

- greedy alignment is O(n * m) comparisons per array and can be beaten by
  hungarian matching on adversarial score matrices. for line items it is fine;
  for arrays of hundreds of near-identical elements both the cost and the
  greedy mispair risk grow.
- the numeric layer trusts its regex. it takes currency symbols and thousands
  separators, refuses "12,34,567" (indian grouping) and "4.800,00" (european
  decimal comma), so real multilocale invoices would need locale-aware parsing
  the ladder deliberately doesnt have.
- zero-score element pairs still pair when slots remain, charging wrong values
  instead of missing plus spurious. denominators are identical either way but
  the per-path attribution lands on the paired fields, which can smear one
  invented element across several rows of the ledger.
- the flaw classes are pure here. real extractors drift, drop, and hallucinate
  at once, and a single scalar over mixed damage is exactly the ambiguity
  field-level P and R exist to split.

## language

typescript. extraction eval is glue you run next to the extraction service,
in the stack the service is written in, and the whole thing is tree walking
and bookkeeping, no numerics ecosystem needed. strict mode plus
noUncheckedIndexedAccess did real work in the recursive comparator.

## open questions

- both alignment and per-pair f1 use the same normalization; a mispriced pair
  under L0 can align differently than under L3. does metric config change the
  alignment itself on messier arrays, and should alignment always run at the
  most forgiving level while scoring runs at the chosen one?
- partial credit inside a leaf: "Acme Industrial" vs "Acme Industrial Supply"
  is 0 here. 20s span-iou thread is the same question one level down.
- weighting: all leaves count 1, so a wrong tax equals a wrong burlap tote
  description. field weights fix the pager story and immediately raise who
  sets them.
- the spurious-only-path blindness of macro wants a third summary number,
  something like hallucinated-structure rate per record, alongside micro and
  macro.
- a real model behind the same harness (json mode on the same 12 documents
  rendered as text) would say which authored flaw class actual extractors
  favor, same missing piece as 01s real-failure-modes thread.
