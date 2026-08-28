# embedding quantization: float32 vs int8 vs int4, recall against memory

store your vectors in 1 byte per dimension instead of 4 and search barely notices. store them in half a byte and it does. this project measures exactly where that line sits, what a float rerank buys back, and two ways scalar quantization fails that are duals of each other.

everything here is synthetic and authored: the vectors are seeded gaussian-mixture and uniform datasets (imported from 13-ann-hnsw), not real embeddings, and both failure modes are injected by this code on purpose. so the numbers demonstrate the mechanics of scalar quantization, how error budget turns into recall loss and which scheme breaks under which input shape. they do not demonstrate what int8 costs on any particular real embedding model, whose value distributions are lumpier than a gaussian mixture. the rogue-dimension experiment is modeled on a real phenomenon (transformer embeddings are known to carry a few large near-constant dimensions) but the magnitude here is chosen, not measured from a model.

## the concept

a float32 vector spends 4 bytes per dimension. scalar quantization maps each value onto a small integer grid and stores the grid coordinates instead:

- **symmetric per-vector int8**: one scale per vector, max|x| / 127, codes in [-127, 127]. no training pass, nothing shared across vectors.
- **asymmetric per-dimension int8**: a [lo, hi] range fitted per dimension over the whole collection, 256 levels inside it. needs a fit pass, and the grid is shared state.
- **int4** is the same per-dimension grid with 16 levels, packed two codes per byte.

search runs on the dequantized reconstruction, queries stay float. so the recall cost is exactly the reconstruction error, and the memory win is exactly the code width. no model, no api, numpy only.

## run it

```
pip install -r requirements.txt
python main.py
python -m pytest -q
```

13-ann-hnsw (and its dependency 02-retrieval-eval) must sit next to this folder; the indexes, datasets, and recall metric are imported from there, not rewritten.

## what the numbers say

flat exact search over 3000 clustered vectors, dim 32, 150 queries, recall@10 against the float64 truth:

| scheme | recall@10 | rmse | bytes | vs fp32 |
|---|---|---|---|---|
| float32 | 1.000 | 0.0000 | 384000 | 1.00x |
| int8-sym-vec | 0.987 | 0.0025 | 108000 | 3.56x |
| int8-asym-dim | 0.985 | 0.0020 | 96256 | 3.99x |
| int4-asym-dim | 0.797 | 0.0343 | 48256 | 7.96x |

int8 is close to free: 4x less memory for about 1.5 points of recall. int4 is not free, it drops 20 points on clustered data (0.888 on uniform, which is easier because the value range is narrower and there are no dense lumps where neighbors sit closer together than one grid step).

**under hnsw** (M=16, efConstruction=100, both indexes built and searched identically), the quantization gap is roughly constant across the ef sweep, +0.013 to +0.017, and the int8 curve converges to its own flat-scan ceiling of 0.985 while fp64 converges to 1.000. so ann error and quantization error just add here; cranking ef cannot buy back what the codes lost, because past ef 40 you are no longer missing neighbors, you are ranking reconstructed points whose order is genuinely different.

**rerank fixes that.** keep codes in RAM, fetch full-precision rows for the short list only:

| scheme | C=10 | C=20 | C=50 |
|---|---|---|---|
| int8-asym-dim | 0.985 | 1.000 | 1.000 |
| int4-asym-dim | 0.797 | 0.977 | 1.000 |

20 float fetches per query make int8 exact. 50 make int4 exact, which is the headline: half a byte per dimension in RAM, 7.96x smaller than fp32, and recall@10 of 1.000 for the price of 50 row fetches per query. quantization decides who is a candidate, floats decide the order, and the candidate set is wrong far less often than the order is.

## the two failure modes

they are duals: what each scheme shares is what breaks it.

**a rogue dimension breaks per-vector symmetric.** append one near-constant dimension at ~40 to vectors whose informative dimensions span ~1.78. true distances barely move (a constant cancels in differences), but max|x| is now 40, the per-vector step becomes 0.315, and every informative dimension keeps ~6 of its 255 levels. recall falls 0.987 to 0.515. the per-dimension grid does not care (0.987): the rogue dimension gets its own tight range. this is the shape real transformer embeddings are known for, so per-vector symmetric on raw embeddings is a footgun.

**rogue vectors break the per-dimension grid.** corrupt 5 rows of 3000 to uniform noise in [-40, 40] and the min/max fit stretches every dimension to cover them: mean step lands at 0.2051, 33x coarser than the 0.0062 the bulk of the data needs, and recall lands at 0.649. per-vector symmetric shrugs (0.987), only the rogue rows themselves quantize badly. the fix is to fit the grid on quantiles instead of min/max: fitting [0.002, 0.998] per dimension gives step 0.0062 and recall 0.983, at the price that outliers clip to the grid edge and reconstruct wrong. clipping 5 garbage rows is the right trade; clipping 5 important customers is not, and nothing in the math knows which one you have.

## tradeoffs and where it breaks down

- the asymmetric grid is trained state. new vectors outside the fitted range clip silently, so a drifting collection needs refit-and-reencode, which is a rebuild in disguise.
- these are synthetic gaussians. real embedding distributions have heavier tails and correlated dimensions; scalar quantization ignores correlation entirely, which is what product quantization exploits, so treat the int8 number as optimistic and the mechanism as the durable lesson.
- rerank assumes float rows are fetchable at all. if they live on disk, C=50 is 50 io hits per query, and the memory saving is really a memory-for-io trade.
- searching dequantized floats measures recall honestly but gives up the speed win of integer simd distance kernels. the memory numbers hold either way; the latency story is unmeasured here.

python because the vectors, the indexes, and the recall metric all live in the python side of this repo (13, 02), and vectorized numpy is the honest way to do this arithmetic. typescript would fight both the ecosystem and the imports.

## open questions

- int8 asym costs 1.5 recall points here, and 13 showed hnsw ef 80 to 320 buys 0.5 points for 6x the distance budget. per byte of RAM, which knob is cheaper at a fixed recall target on one shared sweep
- the quantile clip fraction is a hyperparameter with a cliff on each side, too small keeps the rogue stretch and too large clips real data. an adaptive rule from the observed per-dim histogram is the production question
- product quantization is the standard next step past scalar, subvector codebooks trained by k-means. its extra recall per bit on these exact datasets is unmeasured here
- hnsw built on floats then searched on codes (or the reverse) would split the constant +0.015 gap into build damage vs search damage
- real embeddings over 02's corpus would test the rogue-dimension story against an actual model instead of an authored constant
