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
- `unlink_with_repair`: hard removal plus the local patch, reconnecting
  each removed node's in-neighbors into its surviving out-neighborhood.
  two policies, fill (additive, default) and reselect; measured in
  repair_main.py, see the repair extension section.
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
python3 repair_main.py
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

## the repair extension

main.py measured hard deletes with nobody patching the hole. repair_main.py
turns the standard local patch on and prices it: when a node is removed,
every survivor that pointed at it gains links into the removed node's
surviving out-neighborhood. two patch policies, and the difference between
them turned out to be the whole result:

- fill: keep every surviving edge, select bridge candidates only into the
  slots the removal freed. strictly additive over plain unlinking, and the
  tests hold it to that.
- reselect: re-run neighbor selection over survivors and bridge candidates
  together under the degree cap, which can drop surviving edges.

runs offline like everything else, `python3 repair_main.py`, about 35
seconds. the attacks and the tie-break seeds are exactly section 5's.

**repair works, if it never subtracts.** on the naive build's hub attack,
fill with heuristic selection holds live reachability at 1.000 through 30%
removed where bare unlinking falls to 0.633, and recall ends at 0.774 vs
0.597. across five degree tie draws its reachability never leaves 0.999-1.000,
so the answer survives the draw. fill with naive selection adds
almost exactly the same number of edges (34106 vs 34117) and still lets
reachability slide to 0.770 at 30% removed: the patch's selection rule
matters more than how many edges it adds. the diversity heuristic keeps
bridge edges that point somewhere new, nearest-only fill spends the freed
slots on redundant close edges. thats 13's build ablation appearing a third
time, now inside the delete path, and it means a naive-built graph can be
kept alive by a heuristic patch.

**reselect is worse than doing nothing.** re-selecting whole link lists
under the cap drops 11137 surviving edges over the attack and ends at
reachability 0.135, far below the 0.633 of never repairing at all. any
distance-ranked selection prefers a close bridge candidate over a far
surviving edge, and the far edges are exactly what the damaged graph cannot
afford to lose. a repair that is allowed to subtract connectivity is an
attack with good intentions.

**the patch is one hop, and the sharper attack walks through it.** removing
the 100 earliest inserts cut naive reachability to 0.639 bare; with fill
repair it is 0.639 again, unchanged to three decimals, despite 15012 added
edges. a bridge routes around a single removed node, but each doomed node's
bridge set excludes the rest of the batch, so a path through two removed
nodes in a row is not patched. the earliest inserts are a dense mutually
linked core, which is why this attack was sharper than the hub attack in
the first place, and the region behind that core stays dark no matter how
many edges the patch adds elsewhere. test_the_patch_is_one_hop_only pins
the mechanism on a four-node line.

**what it costs.** heuristic fill spends 1234 distance computations per
removed node, 740641 over the whole 600-removal attack, which is 129.8% of
the 570472 one compact() rebuild costs at that point, and the rebuild comes
back better anyway (recall 0.952 vs 0.774, both at reachability 1.000). so
at 2000 vectors, batch repair loses to rebuild outright. what repair
actually sells is incrementality: 1234 dists after each delete keeps the
graph whole continuously, where the rebuild is 570472 in one lump every
time you need a clean graph right now. naive fill is 483 per removal and
buys less; reselect with heuristic selection is 5442 per removal, 572.4%
of the rebuild bill, for a graph worse than bare unlinking.

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
  shows the worst case when nobody patches, and the repair extension above
  measures the patch, including the policy that makes things worse.
- the repair extension's patch is one hop by construction. it prices the
  standard local patch honestly, but a batch that removes a connected core
  defeats it entirely, and nothing here implements the transitive version
  that would route through the batch.
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

- the one-hop patch dies on the earliest-inserts attack because bridges
  exclude the rest of the batch; a transitive patch that routes through the
  doomed set's closure (follow removed-to-removed edges until a survivor
  turns up) should crack it, at a cost that grows with how interlinked the
  batch is, unmeasured.
- fill-heuristic holds reachability at 1.000 while recall sits at 0.774
  against the rebuild's 0.952, so the patched graph is connected but worse
  shaped; comparing its edge-length distribution against a fresh build
  would say which edges it is missing.
- heuristic fill costs 129.8% of one rebuild at 2000 vectors, but repair
  cost is local (degree times candidates) while rebuild cost scales with
  the whole store; somewhere in n the per-delete repair bill drops under
  the amortized rebuild and that crossover is the number a store actually
  needs.
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
