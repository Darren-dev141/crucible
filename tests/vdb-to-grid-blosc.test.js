// scripts/vdb-to-grid.py reads Blosc compressed VDBs, openvdb's default (#1742). The fixtures in tests/fixtures/vdb are one 16 cubed density grid written
// by Blender's openvdb (blob-blosc.vdb) and its zip twin (blob-zip.vdb, cut from it by tests/fixtures/vdb_zip_twin.py). Skipped when uv is not installed;
// the Blosc decode needs the optional `blosc` package, which uv fetches for the run, and is skipped when that cannot be installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeVolumeGrid } from '../src/volume-grid.js';

const uvAvailable = spawnSync('uv', ['--version'], { encoding: 'utf8' }).status === 0;
const bloscAvailable = uvAvailable && spawnSync('uv', ['run', '--no-project', '--with', 'blosc', 'python', '-c', 'import blosc'], { encoding: 'utf8' }).status === 0;
const skipWithoutUv = !uvAvailable && 'uv is not installed';
const skipWithoutBlosc = !bloscAvailable && 'uv could not install the optional blosc package (offline?)';

// Both fixtures are copied to a file of the same name, because the grid header records the source file name.
function convert(fixtureName, extraUvArguments = []) {
  const folder = mkdtempSync(join(tmpdir(), 'vdb-blosc-'));
  const inputFolder = join(folder, fixtureName);
  mkdirSync(inputFolder);
  copyFileSync(join('tests', 'fixtures', 'vdb', fixtureName + '.vdb'), join(inputFolder, 'blob.vdb'));
  const outputPath = join(folder, fixtureName + '.67vg');
  const run = spawnSync('uv', ['run', '--no-project', ...extraUvArguments, 'scripts/vdb-to-grid.py', join(inputFolder, 'blob.vdb'), outputPath], { encoding: 'utf8' });
  const output = run.status === 0 ? readFileSync(outputPath) : null;
  rmSync(folder, { recursive: true, force: true });
  return { run, output };
}

test('a Blosc VDB converts to the same grid file, byte for byte, as its zip twin', { skip: skipWithoutUv || skipWithoutBlosc, timeout: 120000 }, () => {
  const zip = convert('blob-zip');
  assert.equal(zip.run.status, 0, zip.run.stderr);
  const blosc = convert('blob-blosc', ['--with', 'blosc']);
  assert.equal(blosc.run.status, 0, blosc.run.stderr);
  assert.ok(blosc.output.equals(zip.output), 'the Blosc and zip files must give identical .67vg bytes');
  const grid = decodeVolumeGrid(blosc.output, 'blob.67vg');
  assert.deepEqual(grid.resolution, [16, 16, 16]);
  assert.ok(Math.max(...grid.channels.density) > 0.8, 'the density blob (peak about 0.88) comes through');
});

test('the zip twin converts without any Blosc package, as before', { skip: skipWithoutUv, timeout: 120000 }, () => {
  const zip = convert('blob-zip');
  assert.equal(zip.run.status, 0, zip.run.stderr);
  assert.equal(decodeVolumeGrid(zip.output, 'blob.67vg').resolution.join('x'), '16x16x16');
});

test('a Blosc VDB without a decoder stops with the exact command that adds one', { skip: skipWithoutUv, timeout: 120000 }, () => {
  const blosc = convert('blob-blosc');
  assert.notEqual(blosc.run.status, 0);
  assert.match(blosc.run.stderr, /uv run --no-project --with blosc scripts\/vdb-to-grid\.py/);
});
