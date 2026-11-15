import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { box } from '../src/geometry.js';
import { meshFromGeometry, unwrapUv } from '../src/mesh.js';
import { projectUv, packUvIslands } from '../src/mesh-uv-project.js';
import { bisectPlane } from '../src/mesh-bisect.js';

const crate = () => meshFromGeometry(box(0, 1));

test('projectUv names a mode or axis it does not know instead of projecting silently', () => {
  assert.throws(() => projectUv(crate(), { mode: 'foo' }), /mode was foo; pass one of cube, cylinder, sphere/);
  assert.throws(() => projectUv(crate(), { axis: 'w' }), /axis was w; pass one of x, y, z/);
});

test('uv margin must be a number from 0 to 0.2 in projectUv and packUvIslands', () => {
  for (const margin of [NaN, -0.1, 0.6, Infinity]) {
    assert.throws(() => projectUv(crate(), { margin }), /projectUv: margin was/, `projectUv ${margin}`);
    const unpacked = projectUv(crate(), { pack: false }).mesh;
    assert.throws(() => packUvIslands(unpacked, { margin }), /packUvIslands: margin was/, `packUvIslands ${margin}`);
  }
});

test('unwrapUv refuses a margin outside 0 to 0.2 before it can write non-finite uv', () => {
  for (const margin of [NaN, 0.6, -1]) {
    assert.throws(() => unwrapUv(crate(), { margin }), /unwrapUv: margin was/, `margin ${margin}`);
  }
});

test('bisectPlane blames the distance, not the plane, when distance is NaN or negative', () => {
  for (const distance of [NaN, -1, Infinity]) {
    assert.throws(
      () => bisectPlane(crate(), { point: [0, 0, 0], normal: [0, 1, 0], distance }),
      /bisectPlane: distance was/,
      `distance ${distance}`,
    );
  }
});
