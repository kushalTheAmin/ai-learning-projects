# 21-vector-store-persistence

what happens to a vector index after the demo ends: saving it to disk without
lying to yourself about integrity, growing it in place instead of rebuilding,
and deleting from it, which is the operation hnsw quietly doesnt have.

everything runs offline on seeded synthetic vectors, the same gaussian-mixture
geometry as 13, not real embeddings. so the recall numbers describe how the
graph behaves on lumpy synthetic data, not how it would score on a specific
embedding model. the persistence format, the delete mechanics, and the cost
accounting are real code doing the real operations; the corruption in
experiment 2 is authored (flipped bits, truncation), so what it demonstrates is
that the checksum catches the damage classes it was built to catch, not that
every possible filesystem failure is covered.

## what it does

builds on 13-ann-hnsw by import, not copy. `MutableHnswIndex` subclasses 13's
`HnswIndex` and adds:

- `delete` (tombstone): the node keeps routing queries, it just stops
  appearing in results. `search_live` over-fetches an ef-wide beam and
  filters.
- `unlink` (hard removal): strips the node's edges out of the whole graph,
  no repair. what production systems mostly refuse to do, measured here so
  you can see why.
- `compact`: rebuild a fresh index from the live vectors, full build cost,
  clean graph.
- `export_state` / `restore`: the complete index as data, including the rng
  state, because level draws consume it and an index restored without it
  grows a different graph from that point on.

`persist.py` is the disk format: length-prefixed sections (json header, raw
float64 vectors, u32 link lists) with a sha256 trailer, verified before any
parsing. saves write to a temp file, fsync, then rename, so a crash mid-save
leaves the old store intact instead of a torn file.

## how to run

```
pip install -r requirements.txt
python3 main.py
python3 -m pytest tests/ -q
```

needs 13-ann-hnsw (and transitively 02-retrieval-eval) sitting next to it in
the repo, which is where they are. main.py takes about 2.5 minutes; the graph
math is honest python, see 13's readme for why wall clock is not the cost
unit here. distance computations are.

## the numbers

**1. save/load fidelity.** a 2000-vector store is 738027 bytes total: header
331 + vectors 512000 + links 225632 + framing/checksum 64. so the graph costs
about 44% on top of the raw vectors at m=16, thats the durable price of the
index structure. save 7.9 ms, load 14.5 ms (wall clock, approximate). after a
roundtrip, all 150 queries return identical (id, distance) lists. after 100
further adds on both twins the graphs are identical, link for link. reset the
rng state instead of restoring it and the level draws differ on 12 of 100 new
nodes and the graphs diverge; these 150 queries happen to still agree on all
150, because an ef=80 beam hides small structural differences, but
determinism is gone, and you find out at the worst possible time. thats why
the rng state is in the file.

**2. corruption is refused.** one bit flipped in the vectors, the links, or
the header: checksum mismatch, load refused. truncated by 1000 bytes:
refused. wrong magic: refused as not a store file. the failure mode this
buys out of is the quiet one, a graph that loads fine and searches wrong.

**3. incremental growth vs rebuild per batch.** starting at 1000 vectors
(2206534 distance computations) and adding 500 at a time to 3000: each
incremental batch costs 1421324 to 1704541, where rebuilding from scratch at
the same checkpoints costs 3627858 to 8500499. cumulative over the whole
schedule, incremental is 8500499 vs 26299226 for rebuild-per-batch, 3.09x.
recall is identical either way (0.997 to 0.999 at every checkpoint), and
grown-vs-fresh at 3000 with the same insert order and seed agree on 150/150
queries with bit-identical results: incremental insert IS hnsw's build path,
a build is just 3000 inserts. the rebuild habit comes from indexes that are
actually batch-constructed (lsa in 03, or ivf training); hnsw isnt one of
them. insertion order does matter, but barely here: 5 shuffled builds at
3000 span recall 0.993 to 1.000, mean 0.997, which answers a question 13
left open.

**4. tombstones and the compaction break-even.** deleting 10% to 70% of a
2000-vector store, tombstone recall vs exact-over-live never drops below
0.997 and no query comes up short of k=10, because ef=80 leaves plenty of
live candidates even at 70% dead. the cost is that dists/query is frozen at
304.9 no matter how much is deleted, since the graph never shrinks; a
compacted index answers the same queries in 291.9 (at 10% deleted) down to
212.7 (at 50%), so tombstoning wastes 1.04x to 1.43x per query. compaction
costs one build (4541930 dists at 10% deleted, 1136491 at 70%), which breaks
even after 349558 queries at 10% deleted but only 18770 at 70%: the more you
have deleted, the cheaper the rebuild AND the bigger the per-query saving,
so the break-even collapses by 19x. one oddity worth naming: the compacted
600-vector store costs 244.4 dists/query, more than the 1000-vector one at
212.7; on a small graph a fixed ef=80 beam visits a larger fraction of
everything, so per-query cost is not monotone in index size.

**5. hard deletes need graph diversity to survive.** unlinking up to 30% of
the heuristic-built graph, chosen either at random or by highest layer-0
degree (a deliberate hub attack), recall never leaves the 0.980 to 0.999
band and every live node stays reachable from the entry point. layer-0
degree caps at 32 and 675 of the 2000 heuristic nodes already sit there (630
of the naive ones), so "highest degree" leaves a tie group bigger than any
batch here, and the tie has to be broken on something: a seed, redrawn five
times, since breaking it on the node id would quietly remove the earliest
inserts instead of the hubs. the same attack on a graph built with naive
M-closest selection (13's ablation, same vectors, same attack, different
edges) shrugs off 10% and then goes: at 20% removed live reachability falls
to 0.758 and recall to 0.724, at 30% to 0.633 and 0.597, against an already-
worse 0.844 start. across the five tie draws that is 0.621 to 0.743
reachability and 0.597 to 0.723 recall at 30%, where the heuristic graph
holds reachability 1.000 and recall 0.980 to 0.999, so the gap is much
wider than the draw. the heuristic's job in 13 was keeping rare
cross-cluster edges at build time; this is the same property read as
redundancy under damage. naive graphs route through fewer, more loaded
nodes, so taking the loaded ones out cuts the graph in pieces. tombstones,
the control column, sit at 0.997 throughout because they dont touch the
graph at all.

## tradeoffs and where it breaks down

- the whole store serializes and loads in one piece. fine at 738KB, wrong
  shape at 10M vectors, where you want an append-only log or mmapped
  segments so startup isnt a full deserialize.
- tombstone filtering here is fetch-ef-then-filter with a fixed ef. recall
  stayed high because ef=80 is 8x k; a tighter beam or higher delete
  fraction would need adaptive over-fetch, and the flat 304.9 dists/query
  means the tombstoned store never gets cheaper, only staler.
- the break-even arithmetic treats the store as frozen while queries arrive.
  real stores take inserts and deletes continuously, which turns "when to
  compact" from a one-shot division into a scheduling policy.
- unlink does no repair. real systems that hard-delete (hnswlib's
  markDelete stays tombstone-style for exactly this reason) either keep the
  node or patch the hole by relinking neighbors; the naive-build column
  shows the worst case when nobody patches.
- the checksum protects the file at rest, not the write path end to end. a
  buggy writer that produces a self-consistent wrong file passes.

python because 13 is python and this project is 13's index taken seriously
as a stateful artifact; the persistence layer is stdlib struct/json/hashlib
plus numpy buffers, all boring on purpose. a typescript port would have
rebuilt the index first, and one implementation per language per mechanism
is a repo rule.

## fixes

- 2026-09-01 — section 5's hub attack was not picking hubs. layer-0 degree
  caps at 32 and 675 of the 2000 nodes sit exactly there, so ranking by
  degree left a tie group larger than any batch and the tie broke on node
  id — the first batch was ids 0 through 100, the earliest inserts. degree
  ties are drawn from a seed now, five of them, and both hub columns publish
  the min-max. the number that came out was the naive graph's live
  reachability "0.638 after just 100 removals": no fair draw reproduces it
  (0.751 to 1.000) and removing the 100 earliest inserts by id alone gives
  0.639, so that cell was measuring insertion order. the conclusion holds
  and arrives later — the naive graph shrugs off 10%, then falls to 0.633
  reachability and 0.597 recall at 30% removed, where the heuristic graph
  holds 1.000 and 0.983

## open questions

- unlink-with-repair: reconnect each removed node's in-neighbors to its
  out-neighbors (the standard patch), then re-run the hub attack on the
  naive graph; how much of the 0.638 reachability collapse does local
  repair buy back, and at what edge-update cost?
- the tombstone cost story used a fixed ef; a search that stops when it has
  k live results instead would show the true over-fetch curve, and where a
  70%-dead store forces the beam wide.
- append-only persistence: a snapshot plus a replayed log of adds and
  deletes; at what mutation rate does replay-on-load beat rewriting the
  snapshot, and what does the log cost at query time?
- compaction under load: with inserts and deletes arriving continuously at
  known rates, the break-even division becomes a scheduling problem, the
  same shape as lsm compaction policy, and nothing here measures it.
- per-query cost was non-monotone in index size at fixed ef (212.7 at 1000
  vectors, 244.4 at 600); mapping the ef-vs-n cost surface would say when
  shrinking the store stops paying at fixed beam width.
- removing the earliest-inserted nodes turned out to be its own attack, and a
  sharper one than a fair hub attack at small batch sizes (naive live
  reachability 0.639 vs 0.751-1.000 after 100 removals); early inserts are
  the nodes a small graph had to route everything through, so an
  insertion-order column beside the degree one would say whether age or
  degree is the better predictor of what a graph cannot lose.
