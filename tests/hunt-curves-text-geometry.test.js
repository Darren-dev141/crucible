import assert from 'node:assert/strict';
import test from 'node:test';
import { box } from '../src/geometry.js';
import { groupRings, registerFont, text } from '../src/text-geometry.js';

function countNonFinite(array) {
  let count = 0;
  for (const value of array) if (!Number.isFinite(value)) count++;
  return count;
}

test('a box bevel too small to move the core is refused instead of returning NaN normals', () => {
  for (const bevel of [1e-30, 1e-20, 1e-17]) {
    assert.throws(() => box(bevel, 3), /Box bevel/, `bevel ${bevel}`);
  }
  const smallest = box(1e-10, 3);
  assert.equal(countNonFinite(smallest.positions) + countNonFinite(smallest.normals), 0);
});

test('a glyph whose overlapping contours start inside each other still builds', () => {
  // Two overlapping squares that each begin inside the other: neither is nested in an outline, so neither is a hole.
  const first = [2, 2, 1, 0, 2, 1, 0, 0, 1, 2, 0, 1];
  const second = [1, 1, 1, 3, 1, 1, 3, 3, 1, 1, 3, 1];
  registerFont('OverlapCorners', { unitsPerEm: 16, ascender: 12, descender: -4, glyphs: { O: [4, first, second] } });
  const mesh = text('O', { font: 'OverlapCorners', size: 1, depth: 0.1 });
  assert.ok(mesh.indices.length > 0);
  const rings = [[[2, 2], [0, 2], [0, 0], [2, 0]], [[1, 1], [3, 1], [3, 3], [1, 3]]];
  assert.equal(groupRings(rings).length, 2);
  assert.equal(countNonFinite(mesh.positions) + countNonFinite(mesh.normals), 0);
});
