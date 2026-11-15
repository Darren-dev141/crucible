import assert from 'node:assert/strict';
import test from 'node:test';
import { mat4 } from 'gl-matrix';
import { writeShadowTile } from '../src/local-shadows.js';
import { CascadedShadows } from '../src/cascaded-shadows.js';

function allFinite(values) {
  return Array.from(values).every(Number.isFinite);
}

test('a point light with range 0.05 writes finite shadow tiles', () => {
  const target = new Float32Array(16);
  for (let face = 0; face < 6; face++) {
    writeShadowTile({ light: { position: [0, 1, 0], range: 0.05 }, face }, target);
    assert.ok(allFinite(target), `face ${face} has a non-finite matrix`);
  }
});

function fakeRenderer(near, far) {
  const projection = mat4.perspective(mat4.create(), 1, 1, near, far);
  const view = mat4.lookAt(mat4.create(), [0, 2, 0], [0, 2, -10], [0, 1, 0]);
  const viewProjection = mat4.multiply(mat4.create(), projection, view);
  return {
    world: true,
    activeLightDirection: [-3, 6, 4],
    shadowBounds: {},
    view,
    viewForward: [0, 0, -1],
    inverseViewProjection: mat4.invert(mat4.create(), viewProjection),
  };
}

test('cascade splits stay ordered when the maximum distance is nearer than the camera near plane', () => {
  const cascades = new CascadedShadows({ count: 3, maximumDistance: 1 });
  cascades.fitToCamera(fakeRenderer(5, 500));
  assert.ok(allFinite(cascades.matrices));
  const splits = Array.from(cascades.splits).slice(0, 3);
  assert.ok(splits[0] <= splits[1] && splits[1] <= splits[2], `splits ${splits}`);
  assert.ok(splits[0] >= 5, `first split ${splits[0]} lies in front of the near plane`);
});
