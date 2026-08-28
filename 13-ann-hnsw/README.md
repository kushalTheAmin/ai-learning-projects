# 13-ann-hnsw

exact vs approximate nearest neighbor search, hnsw built from scratch, recall
measured against what it costs.

everything here runs offline. the vectors are synthetic, a seeded gaussian
mixture, not real embeddings; so the recall and cost numbers demonstrate how
the index behaves on lumpy geometry, not how it would score on a specific
embedding model's output. the mechanics being measured (greedy layer descent,
beam width, neighbor selection) are the real algorithm from the hnsw paper,
implemented here in full, not a mock.

## what it does

two indexes over the same 3000 vectors:

- `ExactIndex`: flat scan, one vectorized numpy pass per query. always right,
  always costs n distance computations.
- `HnswIndex`: hierarchical navigable small world. every vector draws a random
  level, upper layers are a sparse highway system, layer 0 holds everyone.
  search greedily descends one closest step per layer, then runs a best-first
  beam of width `ef` on layer 0.

both count every base-vector comparison they make. distance computations are
the honest cost unit here, wall clock is reported but labelled, see below.

## the concept

brute force reads the whole corpus per query. hnsw walks a graph where each
node links to a handful of neighbors, so a query touches a few hundred vectors
instead of all of them, and you pay for it in recall: the walk can settle on a
local minimum and miss part of the true top 10. `ef` is the knob, a wider beam
visits more nodes, misses less, costs more. the whole tradeoff is that curve.

the less obvious part is how links get chosen at build time, and thats where
the ablation lives. the naive rule links each new node to its M closest
candidates. on clustered data those M closest all sit in the same clump, so
clusters connect internally and barely connect to each other, and a query
landing in the wrong basin cant escape. the papers heuristic keeps a candidate
only if it is closer to the new node than to every neighbor already kept,
which suppresses redundant same-direction links and preserves the rare edge
that crosses a gap. measured below: on tight clusters the naive rule strands
145 of 2000 nodes unreachable from the rest of layer 0 and recall drops to
0.809, the heuristic keeps the graph whole at 0.997.

## how to run

```
pip install -r requirements.txt
python3 main.py
python3 -m pytest tests/ -q
```

python because the vector math is numpy and thats also what makes the exact
baseline honest: a compiled full scan is exactly what an ann index has to beat
in practice, and numpy provides it in one line. the graph side is pure python
dicts, heaps and lists, which is the right altitude for seeing the algorithm.

imports `recall_at_k` from 02-retrieval-eval rather than rewriting it: ann
recall@10 is that metric with the exact top 10 as the relevant set.

## the numbers

ef sweep at M=16, efConstruction=100, n=3000, dim 32, 24 clusters, k=10:

```
ef     recall@10   dists/query   vs exact
10     0.979       162           18.5
20     0.995       188           15.9
40     0.997       215           14.0
80     0.999       260           11.5
160    1.000       581           5.2
320    1.000       1221          2.5
```

recall 0.979 at 18.5x fewer distance computations than the exact scan, and
0.995 at 15.9x. the sweep is the whole story of ann: the last half percent of
recall costs more than the first 97.9% did.

M sweep at ef=32 shows the other axis, build cost. M=4 builds for 445 distance
computations per vector and searches at 0.963; M=32 builds 16x more expensive
(7373 per vector) for 0.998. M=16 is the usual production default and lands at
0.997 for 2476 per vector.

neighbor selection ablation, M=8, ef=32:

```
dataset            selection   recall@10   layer-0 reachable
tight clusters     heuristic   0.997       2000 of 2000
tight clusters     naive       0.809       1855 of 2000
uniform            heuristic   0.861       2000 of 2000
uniform            naive       0.846       1996 of 2000
```

on uniform data the two rules are 0.015 apart, on tight clusters the gap is
0.188 and the naive graph is literally disconnected. the heuristic is not a
tuning detail, it is what makes hnsw survive clustered data, and real
embedding spaces are clustered. also worth seeing: uniform 32-d data is
harder for both (0.861 at settings where clustered scores 0.997); with no
cluster structure every direction competes and the beam has to be wider for
the same recall.

## wall clock, and where the distance count lies

one run on this machine printed hnsw ef=32 at 0.360 ms/query vs 0.339 for the
exact scan; those two numbers move a few percent run to run and even swap
order between runs, nothing like the 15x the distance counts promise. the
exact scan is one vectorized numpy pass, hnsw pays python-level overhead per
visited node. at n=3000 they finish near a tie. the distance count is the
portable number: it
says what an implementation with a compiled per-candidate kernel (which is
what hnswlib and faiss are) gets to keep. the honest claim is 15x fewer
distance computations, not 15x faster in this runtime.

## tradeoffs and where it breaks

- recall is per query in aggregate; an individual query near a cluster
  boundary can silently miss its true nearest neighbor. nothing in the api
  reports which queries were the bad ones.
- build is sequential and order-dependent here. 7.4M distance computations to
  build n=3000 at M=16 means the index pays its search savings back only
  after enough queries; a corpus queried a handful of times should just scan.
- no deletes. real hnsw deployments tombstone or rebuild; deleting a hub node
  from the graph can disconnect its region.
- pure python graph traversal wont scale past tens of thousands of vectors on
  wall clock. the algorithm is scale-independent, this implementation is not.
- squared L2 only. cosine is L2 on normalized vectors so this covers the
  common embedding case, but inner-product search (unnormalized) needs a
  different candidate ordering.

## open questions

- deletes: tombstoning vs rebuild, and what fraction of deleted hub nodes it
  takes to fragment recall on this same clustered set
- the ef=160 row nearly doubles cost over ef=80 for the last 0.001 of recall;
  an adaptive ef that stops when the beam stops improving is the obvious next
  build
- quantizing these float64 vectors to int8 before the distance kernel is the
  standard memory play; how much recall does it cost at each ef on this exact
  sweep
- real embeddings: rerun the whole grid on committed vectors from an actual
  model over 02s corpus and see whether the clustered or the uniform column
  is closer to the truth
- the build order is one fixed permutation; hnsw is known to be
  insertion-order sensitive and the variance across seeded shuffles is
  unmeasured here
