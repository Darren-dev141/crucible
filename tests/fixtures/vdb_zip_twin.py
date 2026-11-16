# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy", "blosc"]
# ///
"""Rewrites a one-grid Blosc VDB as its zip compressed twin: the same grid, every value block stored with zlib instead of Blosc.

    uv run --no-project tests/fixtures/vdb_zip_twin.py scripts/vdb-to-grid.py blob-blosc.vdb blob-zip.vdb

Made for tests/fixtures/vdb/ (#1742): openvdb's Python `write` can only produce Blosc files, so the zip twin of a Blosc fixture is cut from it. The
parsing is the reader of scripts/vdb-to-grid.py watched while it walks the file, so each value block is found where the reader finds it; the file
offsets stored in the grid descriptor move by the size each block gained or lost.
"""
import importlib.util
import struct
import sys
import zlib
from pathlib import Path

script_path, source_path, target_path = sys.argv[1:4]
specification = importlib.util.spec_from_file_location("vdb_to_grid", script_path)
converter = importlib.util.module_from_spec(specification)
specification.loader.exec_module(converter)

source = Path(source_path).read_bytes()
value_blocks = []  # (start, end, zip block) of every Blosc block that is stored compressed
grid_starts = []
read_values = converter.read_values
read_grid = converter.read_grid


def watched_read_values(reader, count, compression, from_half, bytes_per_value=None):
    start = reader.offset
    values = read_values(reader, count, compression, from_half, bytes_per_value)
    (stored,) = struct.unpack_from("<q", source, start)
    if stored > 0:
        raw = values.astype("<f2" if from_half else "<f4").tobytes()
        zipped = zlib.compress(raw)
        value_blocks.append((start, reader.offset, struct.pack("<q", len(zipped)) + zipped))
    return values


def watched_read_grid(reader, descriptor, version):
    grid_starts.append(reader.offset)
    return read_grid(reader, descriptor, version)


converter.read_values = watched_read_values
converter.read_grid = watched_read_grid
grids = converter.read_vdb(source_path)
assert len(grid_starts) == 1, "the zip twin is cut from a file with one grid"
assert value_blocks, "the source has no Blosc compressed block"


def moved(offset):
    return offset + sum(len(block) - (end - start) for start, end, block in value_blocks if end <= offset)


output = bytearray()
cursor = 0
for start, end, block in value_blocks:
    output += source[cursor:start] + block
    cursor = end
output += source[cursor:]

flag_position = moved(grid_starts[0])
(compression,) = struct.unpack_from("<I", output, flag_position)
assert compression & converter.COMPRESS_BLOSC
struct.pack_into("<I", output, flag_position, (compression & ~converter.COMPRESS_BLOSC) | converter.COMPRESS_ZIP)

descriptor_position = grid_starts[0] - 24  # the three int64 offsets are read just before the grid and sit ahead of every block, so they did not move
grid_start, block_start, grid_end = struct.unpack_from("<3q", output, descriptor_position)
struct.pack_into("<3q", output, descriptor_position, moved(grid_start), moved(block_start), moved(grid_end))
Path(target_path).write_bytes(bytes(output))
print(f"wrote {target_path}: {len(output)} bytes from {len(source)}, {len(value_blocks)} blocks recoded")
