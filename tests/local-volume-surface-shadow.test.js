// A local volume casts the key light's shadow on opaque surfaces (#1047): castShadow, on by default, dims the sun's direct light at a surface by the optical depth the volume
// puts between it and the sun. The CPU path tracer does it exactly; the rasterizer's post pass scales the finished colour by a share (the raster test checks that).
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLocalVolumes, createLocalVolumeBuffers, packLocalVolumes } from '../src/local-volumes.js';
import { createLocalVolumeSurfaceShadow } from '../src/path-tracer-volume.js';
import { renderPathTracedImage } from '../src/path-tracer.js';

const SMOKE = { shape: 'box', center: [0, 2, 0], size: [4, 2, 4], density: 0.6, falloff: 0.3, absorption: [0.7, 0.8, 1], noiseAmount: 0.6, noiseScale: 2, steps: 16 };
const SUN_TOWARD = [0.6, 1, 0].map(component => component / Math.hypot(0.6, 1, 0));

test('castShadow defaults to true and takes only true or false', () => {
  assert.equal(resolveLocalVolumes([SMOKE])[0].castShadow, true);
  assert.equal(resolveLocalVolumes([{ ...SMOKE, castShadow: false }])[0].castShadow, false);
  for (const bad of ['no', 0, null]) {
    assert.throws(() => resolveLocalVolumes([{ ...SMOKE, castShadow: bad }], 'environment.localVolumes'), /environment\.localVolumes\[0\]\.castShadow must be true or false/);
  }
});

test('the packed grid vector carries the flag in its third component for a box', () => {
  const buffers = createLocalVolumeBuffers();
  packLocalVolumes(resolveLocalVolumes([SMOKE, { ...SMOKE, castShadow: false }]), buffers);
  assert.deepEqual([buffers.grid[2], buffers.grid[6]], [1, 0]);
});

test('a point under the smoke is dimmed along the sun, a point the sun reaches past it is not, and castShadow false takes the volume out', () => {
  const write = createLocalVolumeSurfaceShadow(resolveLocalVolumes([SMOKE]));
  const factor = new Float64Array(3);
  write(-1.2, 0, 0, ...SUN_TOWARD, factor);
  assert.ok(factor.every(value => value > 0 && value < 0.5), `under the smoke ${factor}`);
  write(4, 0, 0, ...SUN_TOWARD, factor);
  assert.deepEqual(Array.from(factor), [1, 1, 1]);
  assert.equal(createLocalVolumeSurfaceShadow(resolveLocalVolumes([{ ...SMOKE, castShadow: false }])), null);
  const bluer = createLocalVolumeSurfaceShadow(resolveLocalVolumes([SMOKE]));
  bluer(-1.2, 0, 0, ...SUN_TOWARD, factor);
  assert.ok(factor[2] < factor[0], `the volume absorbs blue more than red, so less blue gets through: ${factor}`);
});

test('grid and mesh volumes cast no surface shadow yet', () => {
  assert.equal(createLocalVolumeSurfaceShadow([{ ...resolveLocalVolumes([SMOKE])[0], shape: 'grid' }]), null);
  assert.equal(createLocalVolumeSurfaceShadow([{ ...resolveLocalVolumes([SMOKE])[0], mesh: true }]), null);
});

const FLOOR = {
  name: 'ground',
  geometry: { positions: new Float32Array([-20, 0, 20, 20, 0, 20, 20, 0, -20, -20, 0, -20]), normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]), uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) },
  material: { tag: 'surface', metallic: 0, roughness: 1, color: [0.8, 0.8, 0.8], ior: 1.5 },
};
const SIZE = 32;

async function floorFrom(volume) {
  const { linear } = await renderPathTracedImage(
    { parts: [FLOOR], environment: { lightDirection: SUN_TOWARD, keyColor: [3, 3, 3], localVolumes: [volume] }, camera: { eye: [0, 12, 0], target: [0, 0, 0], up: [0, 0, -1], fov: 50 } },
    { width: SIZE, height: SIZE, denoise: false, threads: 1, bounces: 1, samples: 8, seed: 3 },
  );
  return linear;
}

// The floor of the frame is 11.2 m across, so a column is 0.35 m; column 16 is x = 0.
function columnMean(values, column) {
  let total = 0;
  for (let row = 12; row < 20; row++) total += values[(row * SIZE + column) * 3 + 1];
  return total / 8;
}

test('the floor under a noisy smoke box is darker than the open floor, and castShadow false leaves it as it was', async () => {
  const shadowed = await floorFrom(SMOKE);
  const open = await floorFrom({ ...SMOKE, castShadow: false });
  const underColumn = 12;
  const openColumn = 29;
  assert.ok(columnMean(open, underColumn) > 0.05, 'the floor is lit');
  assert.equal(columnMean(shadowed, openColumn), columnMean(open, openColumn), 'the floor the sun reaches past the smoke is not touched');
  const ratio = columnMean(shadowed, underColumn) / columnMean(open, underColumn);
  assert.ok(ratio < 0.8, `the floor under the smoke keeps ${ratio.toFixed(3)} of its light`);
  assert.ok(ratio > 0.2, `the shadow is soft, not black: ${ratio.toFixed(3)}`);
});
