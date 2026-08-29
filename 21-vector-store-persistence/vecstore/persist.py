"""Binary on-disk format for a MutableHnswIndex, with integrity checks.

Layout (all integers little-endian):

    8 bytes   magic b"AIVSTOR1"
    u32       format version (1)
    u32       header length, then that many bytes of JSON: parameters,
              entry point, tombstones, RNG state, distance counter
    u64       vectors length, then raw float64 C-order bytes, shape (size, dim)
    u64       links length, then per node: u32 layer count, and per layer
              a u32 id count followed by that many u32 neighbor ids
    32 bytes  sha256 over everything before it

The checksum is verified before any parsing, so a flipped byte or a
truncated file is refused as corrupt rather than half-loaded into a graph
that silently searches wrong. Saves are atomic: written to a temp file in
the same directory, fsynced, then renamed over the target, so a crash
mid-save leaves the old store intact rather than a torn file.
"""

import hashlib
import json
import os
import struct
from pathlib import Path
from typing import Any

import numpy as np

from .mutable import MutableHnswIndex

MAGIC = b"AIVSTOR1"
VERSION = 1
_CHECKSUM_LEN = 32


class StoreFormatError(ValueError):
    """The bytes are not a loadable vector store."""


def store_to_bytes(index: MutableHnswIndex) -> bytes:
    state = index.export_state()
    header = {
        "dim": state["dim"],
        "m": state["m"],
        "ef_construction": state["ef_construction"],
        "heuristic": state["heuristic"],
        "size": state["size"],
        "entry": state["entry"],
        "max_level": state["max_level"],
        "deleted": state["deleted"],
        "rng_state": state["rng_state"],
        "distance_count": state["distance_count"],
    }
    header_bytes = json.dumps(header, sort_keys=True).encode("utf-8")
    vector_bytes = np.ascontiguousarray(state["vectors"], dtype="<f8").tobytes()
    link_parts: list[bytes] = []
    for layers in state["links"]:
        link_parts.append(struct.pack("<I", len(layers)))
        for ids in layers:
            link_parts.append(struct.pack("<I", len(ids)))
            link_parts.append(np.asarray(ids, dtype="<u4").tobytes())
    link_bytes = b"".join(link_parts)

    body = b"".join(
        [
            MAGIC,
            struct.pack("<I", VERSION),
            struct.pack("<I", len(header_bytes)),
            header_bytes,
            struct.pack("<Q", len(vector_bytes)),
            vector_bytes,
            struct.pack("<Q", len(link_bytes)),
            link_bytes,
        ]
    )
    return body + hashlib.sha256(body).digest()


def store_from_bytes(data: bytes) -> MutableHnswIndex:
    if len(data) < len(MAGIC) + 4:
        raise StoreFormatError(f"file is {len(data)} bytes, too short to be a store")
    if data[: len(MAGIC)] != MAGIC:
        raise StoreFormatError(f"bad magic {data[:len(MAGIC)]!r}, not a vector store file")
    (version,) = struct.unpack_from("<I", data, len(MAGIC))
    if version != VERSION:
        raise StoreFormatError(f"format version {version} is not supported (want {VERSION})")
    if len(data) < len(MAGIC) + 4 + _CHECKSUM_LEN:
        raise StoreFormatError("file ends before the checksum")
    digest = hashlib.sha256(data[:-_CHECKSUM_LEN]).digest()
    if digest != data[-_CHECKSUM_LEN:]:
        raise StoreFormatError("checksum mismatch: file is corrupt or truncated")

    body = memoryview(data)[: len(data) - _CHECKSUM_LEN]
    cursor = len(MAGIC) + 4

    def take(count: int, what: str) -> memoryview:
        nonlocal cursor
        if cursor + count > len(body):
            raise StoreFormatError(f"file ends inside the {what}")
        piece = body[cursor : cursor + count]
        cursor += count
        return piece

    (header_len,) = struct.unpack("<I", take(4, "header length"))
    try:
        header: dict[str, Any] = json.loads(bytes(take(header_len, "header")))
    except json.JSONDecodeError as err:
        raise StoreFormatError(f"header is not valid JSON: {err}") from err
    required = {
        "dim", "m", "ef_construction", "heuristic", "size",
        "entry", "max_level", "deleted", "rng_state", "distance_count",
    }
    missing = required - header.keys()
    if missing:
        raise StoreFormatError(f"header is missing fields: {sorted(missing)}")
    size, dim = header["size"], header["dim"]

    (vector_len,) = struct.unpack("<Q", take(8, "vectors length"))
    if vector_len != size * dim * 8:
        raise StoreFormatError(
            f"vectors section is {vector_len} bytes, "
            f"size {size} x dim {dim} needs {size * dim * 8}"
        )
    vectors = np.frombuffer(take(vector_len, "vectors"), dtype="<f8").reshape(size, dim)

    (link_len,) = struct.unpack("<Q", take(8, "links length"))
    link_end = cursor + link_len
    if link_end != len(body):
        raise StoreFormatError(
            f"links section says {link_len} bytes but {len(body) - cursor} remain"
        )
    links: list[list[list[int]]] = []
    for node in range(size):
        (layer_count,) = struct.unpack("<I", take(4, f"layer count of node {node}"))
        if layer_count < 1 or layer_count > 10_000:
            raise StoreFormatError(f"node {node} claims {layer_count} layers")
        layers: list[list[int]] = []
        for layer in range(layer_count):
            (id_count,) = struct.unpack(
                "<I", take(4, f"link count of node {node} layer {layer}")
            )
            ids = np.frombuffer(
                take(id_count * 4, f"links of node {node} layer {layer}"), dtype="<u4"
            )
            layers.append([int(i) for i in ids])
        links.append(layers)
    if cursor != len(body):
        raise StoreFormatError(f"{len(body) - cursor} unexpected bytes after the links")

    state = dict(header)
    state["vectors"] = vectors
    state["links"] = links
    try:
        return MutableHnswIndex.restore(state)
    except (ValueError, TypeError, KeyError) as err:
        raise StoreFormatError(f"store state is inconsistent: {err}") from err


def save_store(index: MutableHnswIndex, path: str | Path) -> dict[str, int]:
    """Atomic write. Returns section sizes in bytes for accounting."""
    path = Path(path)
    data = store_to_bytes(index)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)

    (header_len,) = struct.unpack_from("<I", data, len(MAGIC) + 4)
    offset = len(MAGIC) + 4 + 4 + header_len
    (vector_len,) = struct.unpack_from("<Q", data, offset)
    offset += 8 + vector_len
    (link_len,) = struct.unpack_from("<Q", data, offset)
    return {
        "total": len(data),
        "header": header_len,
        "vectors": vector_len,
        "links": link_len,
    }


def load_store(path: str | Path) -> MutableHnswIndex:
    return store_from_bytes(Path(path).read_bytes())
