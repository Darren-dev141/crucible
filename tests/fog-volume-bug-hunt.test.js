// Bug hunt over the fog and local volume code (#1463, #1464, #1465).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fogSkyVisibility } from '../src/fog-sky-visibility.js';
import { volumeShadowAmbient } from '../src/fog-field.js';
import { resolveLocalVolumes, createLocalVolumeBuffers, packLocalVolumes } from '../src/local-volumes.js';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function floorPart() {
  const positions = new Float32Array([-50, 0, -50, 50, 0, -50, 50, 0, 50, -50, 0, 50]);
  return { name: 'floor', geometry: { positions, indices: new Uint32Array([0, 2, 1, 0, 3, 2]) }, matrix: IDENTITY };
}

function countingContext() {
  const live = new Set();
  const context = new Proxy({}, {
    get(target, property) {
      if (property === 'createTexture') return () => { const texture = {}; live.add(texture); return texture; };
      if (property === 'deleteTexture') return texture => { live.delete(texture); };
      return () => {};
    },
  });
  return { context, live };
}

test('a fog box that changes does not leave the old sky texture alive (#1463)', () => {
  const { context, live } = countingContext();
  const parts = [floorPart()];
  for (const edge of [4, 5, 6]) {
    fogSkyVisibility(parts, { density: 0.1, minimum: [-4, 0, -4], maximum: [edge, 2, 4] }, context, {});
  }
  assert.equal(live.size, 1, 'only the texture of the current box stays alive');
});

test('the shadow ambient follows the measure it is given, even for the same parts (#1464)', () => {
  const fog = { minimum: [0, 0, 0], maximum: [1, 1, 1] };
  const parts = [floorPart()];
  assert.equal(volumeShadowAmbient(fog, parts, () => 1), 1);
  assert.equal(volumeShadowAmbient(fog, parts, undefined), 0.15);
  assert.equal(volumeShadowAmbient(fog, parts, () => 0.5), 0.575);
});

test('packing refuses a grid volume that was never bound to its grid (#1465)', () => {
  const withSize = resolveLocalVolumes([{ shape: 'grid', center: [0, 0, 0], grid: 'blast', size: [2, 2, 2] }]);
  assert.throws(() => packLocalVolumes(withSize, createLocalVolumeBuffers()), /bindLocalVolumeParts/);
  const withoutSize = resolveLocalVolumes([{ shape: 'grid', center: [0, 0, 0], grid: 'blast' }]);
  assert.throws(() => packLocalVolumes(withoutSize, createLocalVolumeBuffers()), /bindLocalVolumeParts/);
});
