// denseSamples lowers the MSAA sample count on scenes with more than one triangle per pixel (#1163), where the extra samples cost fragment work for little edge quality.
import test from 'node:test';
import assert from 'node:assert/strict';
import { samplesForDensity, DENSE_TRIANGLES_PER_PIXEL } from '../src/renderer.js';

function partWithTriangles(count) {
  return { geometry: { indices: new Uint32Array(count * 3) } };
}

const CANVAS = { clientWidth: 100, clientHeight: 100 };

test('a scene with more than one triangle per pixel uses denseSamples', () => {
  const pixels = 100 * 100 * 1 * 1;
  const parts = [partWithTriangles(pixels * DENSE_TRIANGLES_PER_PIXEL + 1)];
  assert.equal(samplesForDensity(parts, CANVAS, 1, 4, 2), 2);
});

test('a scene at or under one triangle per pixel keeps samples', () => {
  const pixels = 100 * 100;
  assert.equal(samplesForDensity([partWithTriangles(pixels)], CANVAS, 1, 4, 2), 4);
  assert.equal(samplesForDensity([partWithTriangles(10)], CANVAS, 1, 4, 2), 4);
});

test('the pixel ratio counts: the same triangles are sparse at twice the pixel ratio', () => {
  const parts = [partWithTriangles(100 * 100 * 2)];
  assert.equal(samplesForDensity(parts, CANVAS, 1, 4, 2), 2);
  assert.equal(samplesForDensity(parts, CANVAS, 2, 4, 2), 4);
});

test('denseSamples never raises the sample count', () => {
  const parts = [partWithTriangles(100 * 100 * 5)];
  assert.equal(samplesForDensity(parts, CANVAS, 1, 2, 4), 2);
});

test('denseSamples must be a positive integer', () => {
  for (const bad of [0, 1.5, -1, '2']) {
    assert.throws(() => samplesForDensity([], CANVAS, 1, 4, bad), /denseSamples must be a positive integer or null/);
  }
});
