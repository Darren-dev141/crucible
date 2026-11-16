// scripts/grid-to-vdb.py (#1735): a grid file goes to VDB inside Blender and is read back with Blender's openvdb, density unchanged
// (tests/fixtures/grid_vdb_roundtrip.py). Needs Blender (BLENDER_PATH, `blender` on the PATH or the default Windows install); skipped without it.
// scripts/vdb-to-grid.py cannot be the reader here: openvdb's Python write is Blosc compressed and that reader decodes zip only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeVolumeGrid } from '../src/volume-grid.js';

const WINDOWS_BLENDER = 'C:/Program Files/Blender Foundation/Blender 5.3/blender.exe';

function findBlender() {
  if (process.env.BLENDER_PATH) return process.env.BLENDER_PATH;
  if (existsSync(WINDOWS_BLENDER)) return WINDOWS_BLENDER;
  return spawnSync('blender', ['--version'], { encoding: 'utf8' }).status === 0 ? 'blender' : null;
}

const blender = findBlender();

test('explosion-32 survives grid -> VDB -> readback with its density, voxel size and placement kept (needs Blender)', { skip: !blender && 'Blender is not installed (set BLENDER_PATH)', timeout: 120000 }, () => {
  const folder = mkdtempSync(join(tmpdir(), 'grid-to-vdb-'));
  try {
    const fixture = 'tests/fixtures/explosion-32.67vg';
    const run = spawnSync(blender, ['-b', '--factory-startup', '--python', 'tests/fixtures/grid_vdb_roundtrip.py', '--', fixture, folder], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const line = run.stdout.split('\n').find(text => text.startsWith('ROUNDTRIP '));
    assert.ok(line, run.stdout);
    const result = JSON.parse(line.slice('ROUNDTRIP '.length));
    const original = decodeVolumeGrid(readFileSync(fixture), 'original');
    assert.deepEqual(result.resolution, original.resolution);
    assert.deepEqual(Object.keys(result.channels), Object.keys(original.channels));
    for (const [name, channel] of Object.entries(result.channels)) {
      assert.ok(channel.peak > 0.1, `${name} has values`);
      assert.ok(channel.maximum_error <= 1e-6 * channel.peak, `${name} differs by ${channel.maximum_error} (peak ${channel.peak}); half floats widen to float32 exactly`);
    }
    assert.ok(result.maximum_voxel_centre_distance < 1e-3, `voxel centres are ${result.maximum_voxel_centre_distance} off Crucible's texel centres`);
    assert.equal(result.size_metadata, original.size.join(' '));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
