// Density-following self-shadow (#1047): shadowDetail takes more taps along the sun and reads the noise in them, in the CPU path tracer as in the rasterizer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLocalVolumes, createLocalVolumeBuffers, packLocalVolumes, LOCAL_VOLUME_DETAIL_SHADOW_TAPS } from '../src/local-volumes.js';
import { createLocalVolumeCrossing } from '../src/path-tracer-volume.js';

const NOISY_SMOKE = { shape: 'box', center: [0, 1.5, 0], size: [3, 1.5, 3], density: 1.2, falloff: 0.3, absorption: [0.7, 0.8, 1], scatter: 0.8, noiseAmount: 0.9, noiseScale: 2, steps: 32 };
const SUN_COLOR = [3, 3, 3];
const SUN_TOWARD = [1, 0.1, 0].map(component => component / Math.hypot(1, 0.1, 0));
const FULL_SUN = { sun: { direction: SUN_TOWARD, color: SUN_COLOR }, ambient: [0, 0, 0], sunVisibility: () => 1 };

function downRay(volume, x) {
  const crossing = createLocalVolumeCrossing(resolveLocalVolumes([volume]), FULL_SUN);
  const throughput = new Float64Array([1, 1, 1]);
  const emitted = new Float64Array(3);
  crossing(x, 4, 0, 0, -1, 0, 8, 0.5, throughput, emitted);
  return Array.from(emitted);
}

const RAY_POSITIONS = [-1.1, -0.7, -0.3, 0.1, 0.5, 0.9, 1.1];

test('shadowDetail defaults to false and takes only true or false', () => {
  assert.equal(resolveLocalVolumes([NOISY_SMOKE])[0].shadowDetail, false);
  assert.equal(resolveLocalVolumes([{ ...NOISY_SMOKE, shadowDetail: true }])[0].shadowDetail, true);
  for (const bad of ['yes', 1, null]) {
    assert.throws(() => resolveLocalVolumes([{ ...NOISY_SMOKE, shadowDetail: bad }], 'environment.localVolumes'), /environment\.localVolumes\[0\]\.shadowDetail must be true or false/);
  }
});

test('the packed grid vector carries the flag in its second component for a box and leaves the first at 0', () => {
  const buffers = createLocalVolumeBuffers();
  packLocalVolumes(resolveLocalVolumes([NOISY_SMOKE, { ...NOISY_SMOKE, shadowDetail: true }]), buffers);
  assert.deepEqual([buffers.grid[0], buffers.grid[1], buffers.grid[4], buffers.grid[5]], [0, 0, 0, 1]);
  assert.ok(LOCAL_VOLUME_DETAIL_SHADOW_TAPS > 3);
});

test('with the flag off the light a noisy smoke returns is what it was, and with it on the light changes along the box', () => {
  for (const x of RAY_POSITIONS) assert.deepEqual(downRay({ ...NOISY_SMOKE, shadowDetail: false }, x), downRay(NOISY_SMOKE, x));
  const changes = RAY_POSITIONS.map(x => downRay({ ...NOISY_SMOKE, shadowDetail: true }, x)[1] / downRay(NOISY_SMOKE, x)[1]);
  assert.ok(changes.every(change => Number.isFinite(change) && change > 0), `ratios ${changes}`);
  assert.ok(Math.max(...changes) - Math.min(...changes) > 0.05, `the shadow should follow the noise, so the ratio of lit to unlit light varies along the box: ${changes.map(change => change.toFixed(3))}`);
});
