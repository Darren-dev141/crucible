// Fire lights the set (#1046): a local volume with lightsScene adds a point light whose intensity is the emission integrated over the volume.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLocalVolumes } from '../src/local-volumes.js';
import { fireLightsOf } from '../src/local-volume-fire-light.js';
import { encodeVolumeGrid, decodeVolumeGrid, blackbodyRadiance } from '../src/volume-grid.js';
import { bindLocalVolumeParts } from '../src/local-volume-parts.js';
import { registerVolumeGrid } from '../src/volume-grid.js';

const SPHERE = { shape: 'sphere', center: [1, 2, 3], radius: 0.5, emission: [1, 0.5, 0.25], emissionStrength: 4 };

test('lightsScene defaults to false and takes only true or false', () => {
  assert.equal(resolveLocalVolumes([SPHERE])[0].lightsScene, false);
  assert.equal(resolveLocalVolumes([{ ...SPHERE, lightsScene: true }])[0].lightsScene, true);
  for (const bad of ['yes', 1, null]) {
    assert.throws(() => resolveLocalVolumes([{ ...SPHERE, lightsScene: bad }], 'environment.localVolumes'), /environment\.localVolumes\[0\]\.lightsScene must be true or false/);
  }
});

test('a volume with the flag off adds no light', () => {
  assert.deepEqual(fireLightsOf(resolveLocalVolumes([SPHERE])), []);
});

test('a sphere gives one light at its centre with intensity emission times strength times its volume', () => {
  const [light, ...rest] = fireLightsOf(resolveLocalVolumes([{ ...SPHERE, lightsScene: true }]));
  assert.equal(rest.length, 0);
  assert.deepEqual(light.position, [1, 2, 3]);
  const cubicMetres = (4 / 3) * Math.PI * 0.5 ** 3;
  assert.ok(Math.abs(light.intensity - 4 * cubicMetres) < 1e-9);
  assert.deepEqual(light.color.map(channel => Number(channel.toFixed(6))), [1, 0.5, 0.25]);
  assert.ok(light.radius >= 0.05);
});

test('more emission strength gives a stronger light, and a volume that does not emit gives none', () => {
  const weak = fireLightsOf(resolveLocalVolumes([{ ...SPHERE, emissionStrength: 1, lightsScene: true }]))[0];
  const strong = fireLightsOf(resolveLocalVolumes([{ ...SPHERE, emissionStrength: 8, lightsScene: true }]))[0];
  assert.ok(Math.abs(strong.intensity / weak.intensity - 8) < 1e-9);
  assert.deepEqual(fireLightsOf(resolveLocalVolumes([{ ...SPHERE, emission: [0, 0, 0], lightsScene: true }])), []);
});

test('the lights stop at the room the scene has left', () => {
  const volumes = resolveLocalVolumes([{ ...SPHERE, lightsScene: true }, { ...SPHERE, center: [0, 0, 0], lightsScene: true }]);
  assert.equal(fireLightsOf(volumes, 1).length, 1);
  assert.equal(fireLightsOf(volumes, 0).length, 0);
});

test('a grid light sits at the flame, not the box centre, and a blackbody temperature adds light', () => {
  const resolution = [4, 4, 4];
  const flame = new Float32Array(64);
  const temperature = new Float32Array(64);
  const hot = 3 + 3 * 4 + 3 * 16; // the far corner cell
  flame[hot] = 1;
  temperature[hot] = 2000;
  registerVolumeGrid('fire-light-corner', encodeVolumeGrid({ resolution, channels: { density: flame, temperature, flame }, size: [2, 2, 2] }));
  const base = { shape: 'grid', grid: 'fire-light-corner', center: [0, 0, 0], emission: [1, 0, 0], emissionStrength: 1, temperatureScale: 1, lightsScene: true };
  const bound = intensity => bindLocalVolumeParts(resolveLocalVolumes([{ ...base, blackbodyIntensity: intensity }]), []);
  const plain = fireLightsOf(bound(0))[0];
  assert.ok(plain.position.every(axis => Math.abs(axis - 0.75) < 1e-6), `centroid ${plain.position}`);
  const cellCubicMetres = 8 / 64;
  assert.ok(Math.abs(plain.intensity - cellCubicMetres) < 1e-9);
  const withBlackbody = fireLightsOf(bound(1))[0];
  const blackbody = blackbodyRadiance(2000, [0, 0, 0]);
  const expectedRed = 1 * cellCubicMetres + blackbody[0] * cellCubicMetres;
  assert.ok(Math.abs(withBlackbody.intensity - expectedRed) < 1e-9 * Math.max(1, expectedRed));
  assert.ok(withBlackbody.color[1] > 0, 'the blackbody adds green and blue to a red flame');
});

test('decoded grids keep their size, so the test grid above is a real grid file', () => {
  const grid = decodeVolumeGrid(encodeVolumeGrid({ resolution: [1, 1, 1], channels: { density: new Float32Array([1]) }, size: [1, 1, 1] }));
  assert.deepEqual(grid.size, [1, 1, 1]);
});
