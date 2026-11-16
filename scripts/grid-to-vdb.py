"""Convert Crucible volume grid files (.67vg) to OpenVDB files, the reverse of scripts/vdb-to-grid.py. Runs inside Blender's Python, which ships `openvdb`.

    blender -b --factory-startup --python scripts/grid-to-vdb.py -- blast.67vg out/
    blender -b --factory-startup --python scripts/grid-to-vdb.py -- sim_frames_folder out/ --size 4 3 4

Each input is one .67vg file, a folder of them (numeric order) or several paths; every one becomes <name>.vdb in the output folder with FloatGrids
named density, temperature and flame (the channels the file has). Used by scripts/cycles-volume-reference.py, which renders them in Cycles as the
reference for Crucible's grid volumes (docs/volumetric.md, "Cycles reference for grid volumes").

Placement convention (src/local-volumes.js, localVolumeGridSample): a grid volume fills the box [center - size/2, center + size/2] in Crucible's
y up world, texel i of an axis is centred at (i + 0.5) / resolution of the box (sampleVolumeGrid), and x is the fastest axis in the file. Here the
box is centred on the VDB origin (the render script moves it to the volume's `center`), the world size is the header `size` or `--size`, and the
voxel centres are on the same half-voxel offsets. Blender is z up, so Crucible (x, y, z) becomes Blender (x, -z, y), a rotation with no mirroring
(the inverse of the turn vdb-to-grid.py applies). Voxels may be anisotropic when size / resolution differs per axis. The size in Crucible units is
also stored as the grid's `crucible_size` metadata ("x y z"), so a render can rescale a grid to another `size`.
"""
import argparse
import json
import struct
import sys
from pathlib import Path

import numpy
import openvdb

CHANNEL_NAMES = ("density", "temperature", "flame")


def read_volume_grid(path):
    """Returns (resolution, size or None, {channel: float32 array[x][y][z]}) from a .67vg file."""
    data = Path(path).read_bytes()
    if data[:4] != b"67VG":
        raise ValueError(f"{path} is not a Crucible volume grid (missing the 67VG magic)")
    version, header_length = struct.unpack_from("<II", data, 4)
    if version != 1:
        raise ValueError(f"{path} is grid file version {version}; this script reads version 1")
    header = json.loads(data[12:12 + header_length].decode("utf-8"))
    resolution = header["resolution"]
    cell_count = resolution[0] * resolution[1] * resolution[2]
    offset = 12 + header_length
    channels = {}
    for name in header["channels"]:
        halves = numpy.frombuffer(data, dtype="<f2", count=cell_count, offset=offset)
        offset += cell_count * 2
        channels[name] = halves.astype(numpy.float32).reshape(resolution[2], resolution[1], resolution[0]).transpose(2, 1, 0)
    return resolution, header.get("size"), channels


def write_vdb(path, resolution, size, channels):
    size_x, size_y, size_z = size
    voxel = (size_x / resolution[0], size_z / resolution[2], size_y / resolution[1])  # Blender axes: x, y = -Crucible z, z = Crucible y
    minimum = (-size_x / 2, -size_z / 2, -size_y / 2)
    transform = openvdb.createLinearTransform([
        [voxel[0], 0, 0, 0],
        [0, voxel[1], 0, 0],
        [0, 0, voxel[2], 0],
        [minimum[0] + voxel[0] / 2, minimum[1] + voxel[1] / 2, minimum[2] + voxel[2] / 2, 1],
    ])
    grids = []
    for name in CHANNEL_NAMES:
        if name not in channels:
            continue
        in_blender_axes = numpy.ascontiguousarray(numpy.flip(channels[name], axis=2).transpose(0, 2, 1))
        grid = openvdb.FloatGrid()
        grid.name = name
        grid.transform = transform
        grid.copyFromArray(in_blender_axes)
        grid["crucible_size"] = " ".join(f"{extent:.9g}" for extent in size)
        grids.append(grid)
    openvdb.write(str(path), grids)


def input_files(entries):
    files = []
    for entry in entries:
        path = Path(entry)
        if path.is_dir():
            files.extend(sorted(path.glob("*.67vg")))
        elif path.exists():
            files.append(path)
        else:
            raise SystemExit(f"{entry} does not exist; pass a .67vg file or a folder of them")
    if not files:
        raise SystemExit("no .67vg files found")
    return files


def main():
    arguments_after_separator = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    parser = argparse.ArgumentParser(prog="grid-to-vdb.py", description=__doc__.split("\n")[0])
    parser.add_argument("paths", nargs="+", help="one or more .67vg files or folders, then the output folder as the last item")
    parser.add_argument("--size", nargs=3, type=float, metavar=("X", "Y", "Z"), help="world size in Crucible units when the header has none, or to override it")
    arguments = parser.parse_args(arguments_after_separator)
    if len(arguments.paths) < 2:
        parser.error("give at least one input and the output folder")
    output_folder = Path(arguments.paths[-1])
    output_folder.mkdir(parents=True, exist_ok=True)
    for path in input_files(arguments.paths[:-1]):
        resolution, header_size, channels = read_volume_grid(path)
        size = arguments.size or header_size
        if not size:
            raise SystemExit(f"{path} has no size in its header; pass --size X Y Z")
        target = output_folder / (path.stem + ".vdb")
        write_vdb(target, resolution, size, channels)
        print(f"wrote {target}: {resolution[0]}x{resolution[1]}x{resolution[2]} voxels, channels {list(channels)}, size {list(size)}")


main()
