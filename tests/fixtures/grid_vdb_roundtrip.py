"""Blender-side check for tests/grid-to-vdb.test.js: converts a .67vg with scripts/grid-to-vdb.py, reads the VDB back with Blender's openvdb and prints
one JSON line: the largest density error and the largest distance between a voxel centre in the VDB and where Crucible puts that texel.
(scripts/vdb-to-grid.py cannot read this file back: openvdb's Python write is Blosc compressed and that reader decodes zip only.)

    blender -b --factory-startup --python tests/fixtures/grid_vdb_roundtrip.py -- in.67vg out_folder
"""
import importlib.util
import json
import sys
from pathlib import Path

import numpy
import openvdb

input_path, output_folder = sys.argv[sys.argv.index("--") + 1:][:2]
script = Path(__file__).resolve().parents[2] / "scripts" / "grid-to-vdb.py"
sys.argv = [str(script), "--", input_path, output_folder]
specification = importlib.util.spec_from_file_location("grid_to_vdb", script)
module = importlib.util.module_from_spec(specification)
specification.loader.exec_module(module)  # runs main(): writes <stem>.vdb

resolution, size, channels = module.read_volume_grid(input_path)
vdb_path = Path(output_folder) / (Path(input_path).stem + ".vdb")
result = {"channels": {}, "resolution": resolution, "size": size}
for name, expected in channels.items():
    grid = openvdb.read(str(vdb_path), name)
    in_blender_axes = numpy.zeros((resolution[0], resolution[2], resolution[1]), dtype=numpy.float32)
    grid.copyToArray(in_blender_axes, ijk=(0, 0, 0))
    back = numpy.flip(in_blender_axes.transpose(0, 2, 1), axis=2)  # inverse of the writer's turn: Crucible [x][y][z]
    result["channels"][name] = {"maximum_error": float(numpy.abs(back - expected).max()), "peak": float(expected.max())}
grid = openvdb.read(str(vdb_path), "density")
worst_distance = 0.0
for crucible_cell in [(0, 0, 0), (resolution[0] - 1, resolution[1] - 1, resolution[2] - 1), (5, 3, 7), (resolution[0] // 2, resolution[1] // 2, resolution[2] // 2)]:
    local = [((crucible_cell[axis] + 0.5) / resolution[axis] - 0.5) * size[axis] for axis in range(3)]
    expected_world = (local[0], -local[2], local[1])
    index = (crucible_cell[0], resolution[2] - 1 - crucible_cell[2], crucible_cell[1])
    actual_world = grid.transform.indexToWorld(index)
    worst_distance = max(worst_distance, float(numpy.linalg.norm(numpy.array(expected_world) - numpy.array(actual_world))))
result["maximum_voxel_centre_distance"] = worst_distance
result["size_metadata"] = grid["crucible_size"]
print("ROUNDTRIP " + json.dumps(result))
