import test from 'node:test';
import assert from 'node:assert/strict';
import { effectsWithFStop } from '../src/camera-effects.js';
import { resolveThinLens } from '../src/camera.js';

const effects = { depthOfField: { blur: 0, focusDistance: 5 } };
const camera = { eye: [0, 0, 8], target: [0, 0, 0], fStop: 2.8 };

test('raster depth of field focuses at camera.focusDistance when it is set', () => {
  const result = effectsWithFStop(effects, { ...camera, focusDistance: 3 });
  assert.equal(result.depthOfField.focusDistance, 3);
});

test('raster focus plane matches the path tracer thin lens for the same camera', () => {
  const lensCamera = { ...camera, focusDistance: 4.5 };
  const thinLens = resolveThinLens(lensCamera, { aspect: 1, eye: lensCamera.eye, target: lensCamera.target });
  assert.equal(effectsWithFStop(effects, lensCamera).depthOfField.focusDistance, thinLens.focalDistance);
});

test('without focusDistance the raster focuses at the target distance', () => {
  assert.equal(effectsWithFStop(effects, camera).depthOfField.focusDistance, 8);
});

test('a non-positive fStop throws and says what to pass', () => {
  for (const fStop of [-2.8, 0, Number.NaN]) {
    assert.throws(() => effectsWithFStop(effects, { ...camera, fStop }), /Camera fStop must be a positive finite number/);
  }
});

test('a non-positive focusDistance throws', () => {
  assert.throws(() => effectsWithFStop(effects, { ...camera, focusDistance: -1 }), /Camera focusDistance must be a positive finite number/);
});

test('a camera without a target focuses at the distance to the renderer default target', () => {
  const result = effectsWithFStop(effects, { eye: [0, 1.2, 8], fStop: 2.8 });
  assert.equal(result.depthOfField.focusDistance, 8);
});
