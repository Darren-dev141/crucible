// The grid gas simulation (#1735): determinism, a rising plume, mass, vorticity detail, option bounds and the grid files it writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { bakeGasSim, bakeGasSimToGrids, GAS_SIM_TEMPERATURE_UNIT } from '../src/gas-sim.js';
import { findVolumeGrid, volumeGridFloats, encodeVolumeGrid } from '../src/volume-grid.js';

const SMALL = { resolution: 32 };

function frameHashes(bake) {
  return bake.frames.map(frame => createHash('sha256')
    .update(Buffer.from(frame.density.buffer))
    .update(Buffer.from(frame.temperature.buffer))
    .update(Buffer.from(frame.flame.buffer))
    .digest('hex'));
}

function totalDensity(frame) {
  let total = 0;
  for (const value of frame.density) total += value;
  return total;
}

function densityCentroidHeight(frame, bake) {
  const [nx, ny] = bake.resolution;
  const cellSize = bake.size[0] / nx;
  let weighted = 0;
  let total = 0;
  frame.density.forEach((value, index) => {
    weighted += value * (Math.floor(index / nx) % ny + 0.5) * cellSize;
    total += value;
  });
  return weighted / total;
}

// Perimeter over the square root of the area of the thresholded smoke in one horizontal slice: a smooth blob is low, a ragged one high.
function silhouetteRoughness(frame, bake, sliceY, threshold) {
  const [nx, ny, nz] = bake.resolution;
  const inside = (x, z) => x >= 0 && z >= 0 && x < nx && z < nz && frame.density[x + nx * (sliceY + ny * z)] > threshold;
  let area = 0;
  let perimeter = 0;
  for (let z = 0; z < nz; z++) {
    for (let x = 0; x < nx; x++) {
      if (!inside(x, z)) continue;
      area++;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (!inside(x + dx, z + dz)) perimeter++;
    }
  }
  assert.ok(area > 20, `the slice holds ${area} smoke cells, too few to measure`);
  return perimeter / Math.sqrt(area);
}

test('the same options give identical bytes for every frame, another seed does not', () => {
  const first = frameHashes(bakeGasSim({ ...SMALL, frames: 6, seed: 7 }));
  const again = frameHashes(bakeGasSim({ ...SMALL, frames: 6, seed: 7 }));
  const other = frameHashes(bakeGasSim({ ...SMALL, frames: 6, seed: 8 }));
  assert.deepEqual(first, again);
  assert.equal(new Set(first).size, 6, 'every frame differs from the others');
  first.forEach((hash, index) => assert.notEqual(hash, other[index], `frame ${index} ignores the seed`));
});

test('the plume rises over the first second', () => {
  const bake = bakeGasSim({ ...SMALL, frames: 24 });
  const early = densityCentroidHeight(bake.frames[5], bake);
  const late = densityCentroidHeight(bake.frames[23], bake);
  assert.ok(late > early + 0.5, `the smoke centroid went from ${early.toFixed(2)} m to ${late.toFixed(2)} m`);
  assert.equal(bake.fps, 24);
  assert.deepEqual(bake.size, [4, 4, 4]);
});

test('smoke mass is kept without dissipation or burning and falls with dissipation', () => {
  const quiet = { ...SMALL, frames: 10, burstFuel: 0 };
  const kept = bakeGasSim({ ...quiet, dissipation: 0 });
  const afterBurst = totalDensity(kept.frames[5]);
  const later = totalDensity(kept.frames[9]);
  assert.ok(Math.abs(later - afterBurst) / afterBurst < 0.03, `mass went from ${afterBurst.toFixed(1)} to ${later.toFixed(1)}`);
  const faded = bakeGasSim({ ...quiet, dissipation: 1 });
  assert.ok(totalDensity(faded.frames[9]) < later * 0.85, 'dissipation 1 per second keeps less smoke than none');
});

test('vorticity confinement makes the silhouette more ragged', () => {
  const settings = { resolution: 40, frames: 24, burstFuel: 0 };
  const smooth = bakeGasSim({ ...settings, vorticity: 0 });
  const confined = bakeGasSim({ ...settings, vorticity: 8 });
  const smoothRoughness = silhouetteRoughness(smooth.frames[23], smooth, 12, 0.15);
  const confinedRoughness = silhouetteRoughness(confined.frames[23], confined, 12, 0.15);
  assert.ok(confinedRoughness > smoothRoughness * 1.3, `roughness ${smoothRoughness.toFixed(2)} without, ${confinedRoughness.toFixed(2)} with confinement`);
});

test('burning makes flame and heat that die away', () => {
  const bake = bakeGasSim({ ...SMALL, frames: 36 });
  const peak = frame => Math.max(...frame.flame);
  assert.ok(peak(bake.frames[3]) > 0.05, 'the burst burns');
  assert.ok(peak(bake.frames[35]) < peak(bake.frames[3]) * 0.2, 'the flame dies away');
  const hottest = Math.max(...bake.frames[0].temperature);
  assert.ok(hottest > 1 && hottest < 5, `the burst is ${hottest * GAS_SIM_TEMPERATURE_UNIT} K above ambient, grid units of ${GAS_SIM_TEMPERATURE_UNIT} K`);
  assert.ok(Math.max(...bake.frames[35].temperature) < hottest * 0.7, 'the heat cools');
});

test('every option bound throws an error that names the field and its range', () => {
  const cases = [
    [{ resolution: 7 }, /resolution.*8 to 96/],
    [{ resolution: [32, 97, 32] }, /resolution.*8 to 96/],
    [{ resolution: [32, 32] }, /resolution.*\[x, y, z\]/],
    [{ frames: 0 }, /frames.*1 to 240/],
    [{ frames: 241 }, /frames.*1 to 240/],
    [{ frames: 2.5 }, /frames.*integer/],
    [{ fps: 0 }, /fps.*1 to 120/],
    [{ fps: Number.NaN }, /fps.*1 to 120/],
    [{ substeps: 9 }, /substeps.*1 to 8/],
    [{ maxSeconds: 0 }, /maxSeconds.*0\.1 to 3600/],
    [{ pressureIterations: 3 }, /pressureIterations.*4 to 100/],
    [{ advection: 'rk4' }, /advection.*maccormack, semi-lagrangian/],
    [{ burstPosition: [99, 0, 1] }, /burstPosition\[0\].*0 to 8/],
    [{ burstRadius: 0 }, /burstRadius.*0\.05 to 20/]
  ];
  for (const [options, message] of cases) {
    assert.throws(() => bakeGasSim({ frames: 1, ...options }), message, JSON.stringify(options));
  }
});

test('maxSeconds stops a bake that runs over its budget', () => {
  assert.throws(() => bakeGasSim({ resolution: 64, frames: 40, maxSeconds: 0.1 }), /maxSeconds 0\.1 passed.*of 40/);
});

test('bakeGasSimToGrids registers one grid per frame that a grid volume can play', () => {
  const names = bakeGasSimToGrids({ ...SMALL, frames: 3 }, 'gastest');
  assert.deepEqual(names, ['gastest_0000.67vg', 'gastest_0001.67vg', 'gastest_0002.67vg']);
  const grid = findVolumeGrid(names[2], 'test');
  assert.deepEqual(grid.resolution, [32, 32, 32]);
  assert.deepEqual(grid.size, [4, 4, 4]);
  const floats = volumeGridFloats(grid);
  assert.ok(floats.temperature && floats.flame, 'density, temperature and flame are written');
  assert.ok(Math.max(...floats.density) > 0.1);
  const direct = bakeGasSim({ ...SMALL, frames: 3 }).frames[2];
  const expected = encodeVolumeGrid({ resolution: [32, 32, 32], channels: direct, size: [4, 4, 4] });
  assert.equal(expected.length, 12 + Math.ceil(JSON.stringify({ resolution: [32, 32, 32], channels: ['density', 'temperature', 'flame'], size: [4, 4, 4] }).length / 4) * 4 + 32 ** 3 * 6);
  assert.throws(() => bakeGasSimToGrids({ resolution: 96, frames: 240 }, 'toobig'), /sequence limit.*frames up to/);
  assert.throws(() => bakeGasSimToGrids({}, ''), /namePrefix/);
});

test('a 32 cubed bake of 24 frames takes a few seconds', t => {
  const started = performance.now();
  bakeGasSim({ ...SMALL, frames: 24 });
  t.diagnostic(`32^3 x 24 frames: ${((performance.now() - started) / 1000).toFixed(2)} s`);
});
