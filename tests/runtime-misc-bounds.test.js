import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMotionExpression } from '../src/motion-expression.js';
import { evaluateField, pointSetContext } from '../src/mesh-fields.js';
import { filletCurve } from '../src/curve-operations.js';
import { createTileField } from '../src/tile-field.js';
import { createGrass } from '../src/grass.js';

const motionValue = expression => compileMotionExpression(expression, new Set(), 'Driver').evaluate({ time: 0, read: () => 0 });
const fieldValue = expression => {
  const points = new Float64Array([0, 0, 0]);
  return evaluateField(expression, pointSetContext(points, points)).values[0];
};

test('field div and mod give 0 when the result would overflow, not Infinity or NaN', () => {
  const tinyDivisor = 1e-320;
  assert.equal(fieldValue({ div: [1, tinyDivisor] }), 0);
  assert.equal(fieldValue({ mod: [1, tinyDivisor] }), 0);
  assert.equal(motionValue({ mod: [1, tinyDivisor] }), 0);
  assert.equal(fieldValue({ add: [{ div: [1, tinyDivisor] }, 2] }), 2);
  assert.equal(fieldValue({ div: [6, 3] }), 2);
  assert.equal(fieldValue({ mod: [7, 3] }), 1);
});

test('filletCurve refuses arc segment counts that give NaN points or an unbounded build', () => {
  const corners = [[0, 0, 0], [1, 0, 0], [1, 1, 0]];
  for (const arcSegments of [0, -1, 1.5, NaN, 1e9]) {
    assert.throws(() => filletCurve(corners, 0.2, arcSegments), /arcSegments/, `arcSegments ${arcSegments}`);
  }
  const rounded = filletCurve(corners, 0.2, 4);
  assert.ok(rounded.flat().every(Number.isFinite));
});

test('a tile field over the tile limit throws and says to enlarge tileSize', () => {
  const area = { minX: 0, maxX: 1000, minZ: 0, maxZ: 1000 };
  const options = { area, levels: [{ distance: 10 }], cullDistance: 10, terrainHeight: () => 0, buildParts: () => [] };
  assert.throws(() => createTileField({ ...options, tileSize: 1 }), /tileSize/);
  assert.equal(createTileField({ ...options, tileSize: 10 }).stats().tiles, 10000);
});

test('grass over a huge area with a tiny tileSize throws before building tiles', () => {
  const area = { minX: 0, maxX: 1000, minZ: 0, maxZ: 1000 };
  assert.throws(() => createGrass({ area, tileSize: 1, eye: [0, 1, 0] }), /tileSize/);
});
