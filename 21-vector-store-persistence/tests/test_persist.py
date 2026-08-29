import struct

import numpy as np
import pytest

from vecstore import (
    MutableHnswIndex,
    StoreFormatError,
    clustered_dataset,
    load_store,
    save_store,
    store_from_bytes,
    store_to_bytes,
)
from vecstore.persist import MAGIC


def small_index(n: int = 80, dim: int = 6, seed: int = 5) -> MutableHnswIndex:
    data = clustered_dataset(n_vectors=n, n_queries=1, dim=dim, n_clusters=3, seed=seed)
    index = MutableHnswIndex(dim=dim, m=6, ef_construction=30, seed=seed)
    for row in data.vectors:
        index.add(row)
    return index


def query(dim: int = 6) -> np.ndarray:
    return np.random.default_rng(77).uniform(0.0, 1.0, size=dim)


class TestRoundtrip:
    def test_state_survives_bytes(self):
        index = small_index()
        index.delete(4)
        index.delete(31)
        loaded = store_from_bytes(store_to_bytes(index))
        assert loaded.dim == index.dim
        assert loaded.m == index.m
        assert loaded.ef_construction == index.ef_construction
        assert loaded.heuristic == index.heuristic
        assert len(loaded) == len(index)
        assert loaded._entry == index._entry
        assert loaded._max_level == index._max_level
        assert loaded._links == index._links
        assert loaded._deleted == index._deleted
        assert loaded.distance_count == index.distance_count
        assert loaded._rng.bit_generator.state == index._rng.bit_generator.state
        assert np.array_equal(loaded._store[: len(loaded)], index._store[: len(index)])

    def test_search_identical_after_roundtrip(self):
        index = small_index()
        index.delete(10)
        loaded = store_from_bytes(store_to_bytes(index))
        assert loaded.search_live(query(), 10, 30) == index.search_live(query(), 10, 30)

    def test_growth_identical_after_roundtrip(self):
        index = small_index()
        loaded = store_from_bytes(store_to_bytes(index))
        extra = np.random.default_rng(8).uniform(0.0, 1.0, size=(25, index.dim))
        for row in extra:
            index.add(row)
            loaded.add(row)
        assert loaded._links == index._links
        assert loaded.search_live(query(), 10, 30) == index.search_live(query(), 10, 30)

    def test_empty_index_roundtrips(self):
        index = MutableHnswIndex(dim=4, m=4, ef_construction=8, seed=1)
        loaded = store_from_bytes(store_to_bytes(index))
        assert len(loaded) == 0
        assert loaded.search_live(np.zeros(4), 5, 8) == []
        loaded.add(np.ones(4))
        assert loaded.search_live(np.zeros(4), 5, 8) == [(0, 4.0)]

    def test_single_vector_roundtrips(self):
        index = MutableHnswIndex(dim=2, m=2, ef_construction=4, seed=1)
        index.add(np.array([1.5, -2.5]))
        loaded = store_from_bytes(store_to_bytes(index))
        assert loaded.search_live(np.zeros(2), 1, 4) == index.search_live(np.zeros(2), 1, 4)

    def test_duplicate_vectors_keep_distinct_ids(self):
        index = MutableHnswIndex(dim=2, m=2, ef_construction=4, seed=1)
        row = np.array([0.5, 0.5])
        index.add(row)
        index.add(row)
        index.add(row)
        loaded = store_from_bytes(store_to_bytes(index))
        found = loaded.search_live(row, 3, 8)
        assert [node for node, _ in found] == [0, 1, 2]

    def test_file_roundtrip_and_sizes(self, tmp_path):
        index = small_index()
        path = tmp_path / "store.bin"
        sizes = save_store(index, path)
        assert path.stat().st_size == sizes["total"]
        assert sizes["vectors"] == len(index) * index.dim * 8
        assert not (tmp_path / "store.bin.tmp").exists()
        loaded = load_store(path)
        assert loaded.search_live(query(), 5, 30) == index.search_live(query(), 5, 30)

    def test_save_overwrites_atomically(self, tmp_path):
        index = small_index()
        path = tmp_path / "store.bin"
        save_store(index, path)
        index.delete(0)
        save_store(index, path)
        assert load_store(path)._deleted == {0}


class TestRefusal:
    def test_every_byte_position_is_guarded_against_flips(self):
        blob = store_to_bytes(small_index(n=12))
        step = max(1, len(blob) // 97)
        for position in range(0, len(blob), step):
            corrupt = bytearray(blob)
            corrupt[position] ^= 0x40
            with pytest.raises(StoreFormatError):
                store_from_bytes(bytes(corrupt))

    def test_truncation_refused_at_any_cut(self):
        blob = store_to_bytes(small_index(n=12))
        for cut in (0, 3, len(MAGIC), 40, len(blob) // 2, len(blob) - 1):
            with pytest.raises(StoreFormatError):
                store_from_bytes(blob[:cut])

    def test_trailing_junk_refused(self):
        blob = store_to_bytes(small_index(n=12))
        with pytest.raises(StoreFormatError):
            store_from_bytes(blob + b"x")

    def test_wrong_magic_refused(self):
        blob = store_to_bytes(small_index(n=12))
        with pytest.raises(StoreFormatError, match="magic"):
            store_from_bytes(b"NOTSTORE" + blob[8:])

    def test_unsupported_version_refused(self):
        blob = bytearray(store_to_bytes(small_index(n=12)))
        struct.pack_into("<I", blob, len(MAGIC), 2)
        with pytest.raises(StoreFormatError, match="version"):
            store_from_bytes(bytes(blob))

    def test_consistent_checksum_but_bad_state_refused(self):
        import hashlib
        import json

        blob = store_to_bytes(small_index(n=12))
        (header_len,) = struct.unpack_from("<I", blob, len(MAGIC) + 4)
        start = len(MAGIC) + 8
        header = json.loads(blob[start : start + header_len])
        header["entry"] = 999
        header_bytes = json.dumps(header, sort_keys=True).encode()
        body = (
            blob[: len(MAGIC) + 4]
            + struct.pack("<I", len(header_bytes))
            + header_bytes
            + blob[start + header_len : -32]
        )
        evil = body + hashlib.sha256(body).digest()
        with pytest.raises(StoreFormatError, match="inconsistent"):
            store_from_bytes(evil)
